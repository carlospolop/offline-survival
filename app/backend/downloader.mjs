import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { artifactName, classifySourcePath } from "./catalog.mjs";
import { now, recordEvent } from "./state.mjs";

const execFileAsync = promisify(execFile);
const active = new Map();
const connectTimeoutMs = Number(process.env.SCA_DOWNLOAD_CONNECT_TIMEOUT_MS ?? 30_000);
const maxStreamAttempts = Number(process.env.SCA_DOWNLOAD_STREAM_ATTEMPTS ?? 4);
const progressIntervalMs = Number(process.env.SCA_DOWNLOAD_PROGRESS_INTERVAL_MS ?? 1_000);
const downloadMaxBytesPerSecond = Number(process.env.SCA_DOWNLOAD_MAX_MBPS ?? 0) * 1_000_000;
const hashMaxBytesPerSecond = Number(process.env.SCA_HASH_MAX_MBPS ?? 0) * 1_000_000;

export async function sha256File(file) {
  const hash = crypto.createHash("sha256");
  await new Promise((resolve, reject) => {
    const limiter = createRateLimiter(hashMaxBytesPerSecond);
    const stream = fs.createReadStream(file);
    stream
      .on("data", async (chunk) => {
        stream.pause();
        hash.update(chunk);
        await limiter(chunk.length);
        stream.resume();
      })
      .on("error", reject)
      .on("end", resolve);
  });
  return hash.digest("hex");
}

export async function currentLibraryBytes(root) {
  async function walk(dir) {
    let total = 0;
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) total += await walk(full);
      if (entry.isFile()) total += (await fsp.stat(full)).size;
    }
    return total;
  }
  return walk(root);
}

export async function downloadSource({ db, libraryRoot, source, diskBudgetBytes = Infinity, fetchImpl = fetch }) {
  if (active.has(source.id)) return active.get(source.id).promise;
  const controller = new AbortController();
  const promise = doDownload({ db, libraryRoot, source, diskBudgetBytes, fetchImpl, signal: controller.signal }).finally(() => active.delete(source.id));
  active.set(source.id, { promise, controller });
  return promise;
}

async function doDownload({ db, libraryRoot, source, diskBudgetBytes, fetchImpl, signal }) {
  const existingBytes = await currentLibraryBytesIfBudgeted(libraryRoot, diskBudgetBytes);
  const expected = Number(source.expected_size_bytes ?? 0);
  if (hasDiskBudget(diskBudgetBytes) && existingBytes + expected > diskBudgetBytes) {
    throw new Error(`Disk budget exceeded: current ${existingBytes} + expected ${expected} > ${diskBudgetBytes}`);
  }

  const relDir = classifySourcePath(source);
  const relPath = path.join(relDir, artifactName(source));
  const finalPath = path.join(libraryRoot, relPath);
  const tmpPath = path.join(libraryRoot, "tmp", `${source.id}.part`);
  await fsp.mkdir(path.dirname(finalPath), { recursive: true });
  await fsp.mkdir(path.dirname(tmpPath), { recursive: true });

  db.prepare("INSERT INTO downloads (id, source_id, status, total_bytes, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status=excluded.status, total_bytes=excluded.total_bytes, updated_at=excluded.updated_at")
    .run(source.id, source.id, "downloading", expected, now());
  db.prepare("UPDATE sources SET status=?, updated_at=? WHERE id=? AND status NOT IN ('downloaded', 'verified', 'indexed')")
    .run("downloading", now(), source.id);

  try {
    let resumed = false;
    if (source.download?.action === "git_archive") {
      await cloneGitArchive({ db, source, tmpPath, signal });
    } else {
      for (let attempt = 1; attempt <= maxStreamAttempts; attempt += 1) {
        try {
          const result = await transferToPartial({ db, libraryRoot, source, tmpPath, existingBytes, expected, diskBudgetBytes, fetchImpl, signal });
          resumed = resumed || result.resumed;
          break;
        } catch (error) {
          const paused = isPauseError(error, signal);
          if (paused || attempt >= maxStreamAttempts) throw error;
          const partialBytes = await fsp.stat(tmpPath).then((stat) => stat.size).catch(() => 0);
          db.prepare("UPDATE downloads SET bytes_received=?, status=?, error=?, updated_at=? WHERE id=?")
            .run(partialBytes, "resuming", `Stream interrupted, retrying ${attempt + 1}/${maxStreamAttempts}: ${String(error.message ?? error)}`, now(), source.id);
          recordEvent(db, "download-retry-stream", `${source.title} stream interrupted; resuming partial download`, { sourceId: source.id, attempt: attempt + 1, partialBytes });
        }
      }
    }
    const digest = await sha256File(tmpPath);
    const expectedHash = source.sha256 || await resolveChecksum(source, fetchImpl, signal);
    if (expectedHash && digest !== expectedHash) throw new Error(`Checksum mismatch: expected ${expectedHash}, got ${digest}`);
    const existingBlob = db.prepare("SELECT * FROM blobs WHERE sha256=?").get(digest);
    if (existingBlob) {
      await fsp.rm(tmpPath, { force: true });
      db.prepare("UPDATE blobs SET ref_count=ref_count+1 WHERE sha256=?").run(digest);
      const size = Number(existingBlob.size_bytes);
      db.prepare("UPDATE downloads SET bytes_received=?, total_bytes=?, status=?, error=NULL, updated_at=? WHERE id=?").run(size, size, "complete", now(), source.id);
      db.prepare("UPDATE sources SET status=?, size_bytes=?, sha256=?, local_path=?, duplicate_of=?, updated_at=? WHERE id=?")
        .run("downloaded", size, digest, existingBlob.local_path, digest, now(), source.id);
      recordEvent(db, "dedupe", `${source.title} reused existing blob ${digest}`, { sourceId: source.id, sha256: digest });
      return { sourceId: source.id, path: existingBlob.local_path, size, sha256: digest, deduped: true };
    }

    await fsp.rename(tmpPath, finalPath);
    const size = (await fsp.stat(finalPath)).size;
    db.prepare("INSERT INTO blobs (sha256, size_bytes, local_path, ref_count, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(digest, size, relPath, 1, now());
    db.prepare("UPDATE downloads SET bytes_received=?, total_bytes=?, status=?, error=NULL, updated_at=? WHERE id=?").run(size, size, "complete", now(), source.id);
    db.prepare("UPDATE sources SET status=?, size_bytes=?, sha256=?, local_path=?, duplicate_of=NULL, updated_at=? WHERE id=?").run("downloaded", size, digest, relPath, now(), source.id);
    recordEvent(db, "download", `${source.title} downloaded and verified`, { sourceId: source.id, size, sha256: digest, resumed });
    return { sourceId: source.id, path: relPath, size, sha256: digest };
  } catch (error) {
    const paused = isPauseError(error, signal);
    if (!paused) await fsp.rm(tmpPath, { force: true });
    db.prepare("UPDATE downloads SET status=?, error=?, updated_at=? WHERE id=?").run(paused ? "paused" : "failed", String(error.message ?? error), now(), source.id);
    db.prepare("UPDATE sources SET status=?, updated_at=? WHERE id=?").run(paused ? "paused" : "broken", now(), source.id);
    throw error;
  }
}

async function cloneGitArchive({ db, source, tmpPath, signal }) {
  if (signal?.aborted) throw new Error("Download paused");
  const cloneDir = `${tmpPath}.git-worktree`;
  const outputDir = path.dirname(tmpPath);
  await fsp.mkdir(outputDir, { recursive: true });
  // Use the library's own tmp dir as CWD — it's just been created above and lives
  // in the user's home folder, so it won't be garbage-collected mid-clone the way
  // macOS per-process TMPDIR paths (/var/folders/…) can be.
  const commandCwd = outputDir;
  await fsp.rm(cloneDir, { recursive: true, force: true });
  await fsp.rm(tmpPath, { force: true });
  try {
    db.prepare("UPDATE downloads SET bytes_received=?, total_bytes=?, status=?, error=NULL, updated_at=? WHERE id=?")
      .run(0, Number(source.expected_size_bytes ?? 0), "downloading", now(), source.id);
    const gitBin = await findGitBin(commandCwd);
    if (!gitBin) throw new Error("git is not installed. Install git (https://git-scm.com) and retry.");
    await execFileSafe(gitBin, ["clone", "--depth", "1", source.url, cloneDir], { cwd: commandCwd, maxBuffer: 20 * 1024 * 1024 });
    await fsp.rm(path.join(cloneDir, ".git"), { recursive: true, force: true });
    if (signal?.aborted) throw new Error("Download paused");
    await zipDirectoryToFile(cloneDir, tmpPath);
    const size = (await fsp.stat(tmpPath)).size;
    db.prepare("UPDATE downloads SET bytes_received=?, total_bytes=?, status=?, error=NULL, updated_at=? WHERE id=?")
      .run(size, size, "downloading", now(), source.id);
  } finally {
    await fsp.rm(cloneDir, { recursive: true, force: true });
  }
}

async function findGitBin(cwd) {
  const candidates = process.platform === "win32"
    ? ["git", "C:\\Program Files\\Git\\bin\\git.exe", "C:\\Program Files (x86)\\Git\\bin\\git.exe"]
    : ["/usr/bin/git", "/usr/local/bin/git", "/opt/homebrew/bin/git", "/opt/local/bin/git", "git"];
  for (const bin of candidates) {
    try { await execFileSafe(bin, ["--version"], { cwd, timeout: 4000 }); return bin; } catch { /* try next */ }
  }
  return null;
}

async function stableExternalCommandCwd() {
  const candidates = [
    process.env.SCA_EXTERNAL_COMMAND_CWD,
    os.tmpdir(),
    path.dirname(process.execPath),
    path.parse(os.tmpdir()).root
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await fsp.mkdir(candidate, { recursive: true });
      const real = await fsp.realpath(candidate);
      const stat = await fsp.stat(real);
      if (stat.isDirectory()) return real;
    } catch {
      /* try next */
    }
  }
  return path.parse(os.tmpdir()).root;
}

async function execFileSafe(command, args, options = {}) {
  const cwd = options.cwd ?? await stableExternalCommandCwd();
  await fsp.mkdir(cwd, { recursive: true });
  const env = { ...process.env, ...options.env, PWD: cwd };
  return execFileAsync(command, args, { ...options, cwd, env });
}

async function zipDirectoryToFile(srcDir, destPath) {
  const files = [];
  const collectFiles = async (dir) => {
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { await collectFiles(full); continue; }
      const relPath = path.relative(srcDir, full).split(path.sep).join("/");
      files.push({ name: relPath, data: await fsp.readFile(full) });
    }
  };
  await collectFiles(srcDir);
  const locals = [], chunks = [];
  let pos = 0;
  for (const { name, data } of files) {
    const nb = Buffer.from(name, "utf8");
    const comp = zlib.deflateRawSync(data, { level: 6 });
    const useComp = comp.length < data.length;
    const fd = useComp ? comp : data;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 6); lh.writeUInt16LE(useComp ? 8 : 0, 8);
    lh.writeUInt32LE(0, 10); lh.writeUInt32LE(0, 14);
    lh.writeUInt32LE(fd.length, 18); lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nb.length, 26); lh.writeUInt16LE(0, 28);
    locals.push({ offset: pos, nb, cs: fd.length, us: data.length });
    chunks.push(lh, nb, fd);
    pos += 30 + nb.length + fd.length;
  }
  const cdStart = pos;
  for (let i = 0; i < files.length; i++) {
    const { nb, offset, cs, us } = locals[i];
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(0x0014, 4); cd.writeUInt16LE(20, 6);
    cd.writeUInt32LE(0, 16); cd.writeUInt32LE(cs, 20); cd.writeUInt32LE(us, 24);
    cd.writeUInt16LE(nb.length, 28); cd.writeUInt32LE(offset, 42);
    chunks.push(cd, nb); pos += 46 + nb.length;
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10); eocd.writeUInt32LE(pos - cdStart, 12);
  eocd.writeUInt32LE(cdStart, 16);
  chunks.push(eocd);
  await fsp.writeFile(destPath, Buffer.concat(chunks));
}

async function transferToPartial({ db, source, tmpPath, existingBytes, expected, diskBudgetBytes, fetchImpl, signal }) {
  const existingPartial = await fsp.stat(tmpPath).then((stat) => stat.size).catch(() => 0);
  const response = await fetchWithFallback(source, fetchImpl, signal, existingPartial);
  const resumed = existingPartial > 0 && response.status === 206;
  const totalHeader = Number(response.headers.get("content-length") ?? 0);
  const total = resumed ? existingPartial + totalHeader : totalHeader || expected;
  let received = resumed ? existingPartial : 0;
  let lastProgressUpdate = 0;
  const limiter = createRateLimiter(downloadMaxBytesPerSecond);
  const file = fs.createWriteStream(tmpPath, { flags: resumed ? "a" : "w" });
  try {
    for await (const value of Readable.fromWeb(response.body)) {
      if (signal?.aborted) throw new Error("Download paused");
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      received += chunk.byteLength;
      if (hasDiskBudget(diskBudgetBytes) && existingBytes + received > diskBudgetBytes) throw new Error("Disk budget exceeded during download");
      if (!file.write(chunk)) await once(file, "drain");
      const timestamp = Date.now();
      if (timestamp - lastProgressUpdate > progressIntervalMs || received >= total) {
        db.prepare("UPDATE downloads SET bytes_received=?, total_bytes=?, status=?, updated_at=? WHERE id=?").run(received, Math.max(total, received), resumed ? "resuming" : "downloading", now(), source.id);
        lastProgressUpdate = timestamp;
      }
      await limiter(chunk.byteLength);
    }
  } finally {
    await new Promise((resolve, reject) => file.end((error) => (error ? reject(error) : resolve())));
  }
  return { resumed };
}

function createRateLimiter(maxBytesPerSecond) {
  if (!maxBytesPerSecond || maxBytesPerSecond <= 0) return async () => {};
  let windowStarted = Date.now();
  let bytesThisWindow = 0;
  return async (bytes) => {
    bytesThisWindow += bytes;
    const elapsed = Date.now() - windowStarted;
    const expectedElapsed = (bytesThisWindow / maxBytesPerSecond) * 1000;
    if (expectedElapsed > elapsed) await sleep(expectedElapsed - elapsed);
    if (Date.now() - windowStarted >= 1000) {
      windowStarted = Date.now();
      bytesThisWindow = 0;
    }
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.min(Math.max(ms, 0), 5_000)));
}

function isPauseError(error, signal) {
  return String(error?.message ?? error).toLowerCase().includes("paused") || signal?.aborted;
}

async function fetchWithFallback(source, fetchImpl, signal, existingPartial = 0) {
  const urls = candidateUrls(source);
  const errors = [];
  for (const url of urls) {
    try {
      const headers = existingPartial ? { Range: `bytes=${existingPartial}-` } : {};
      let response = await fetchWithTimeout(fetchImpl, url, { signal, headers }, connectTimeoutMs);
      if (existingPartial && response.status === 416) response = await fetchWithTimeout(fetchImpl, url, { signal }, connectTimeoutMs);
      if (existingPartial && response.status !== 206) response = await fetchWithTimeout(fetchImpl, url, { signal }, connectTimeoutMs);
      if (response.ok || response.status === 206) return response;
      errors.push(`${url}: HTTP ${response.status} ${response.statusText}`);
    } catch (error) {
      errors.push(`${url}: ${String(error.message ?? error)}`);
    }
  }
  throw new Error(`All mirrors failed: ${errors.join("; ")}`);
}

function candidateUrls(source) {
  const urls = [source.url, ...(source.mirrors ?? []), ...(source.mirror_urls ?? [])].filter(Boolean);
  const expanded = [];
  for (const url of urls) {
    const kiwixMirrors = kiwixMirrorUrls(url);
    expanded.push(...kiwixMirrors, url);
  }
  return [...new Set(expanded)];
}

function kiwixMirrorUrls(url) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "download.kiwix.org" || !parsed.pathname.startsWith("/zim/")) return [];
    return [
      `https://ftp.nluug.nl/pub/kiwix${parsed.pathname}`,
      `https://mirrors.dotsrc.org/kiwix${parsed.pathname}`,
      `https://ftp.fau.de/kiwix${parsed.pathname}`
    ];
  } catch {
    return [];
  }
}

async function fetchWithTimeout(fetchImpl, url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Connection timed out after ${timeoutMs}ms`)), timeoutMs);
  const outerSignal = options.signal;
  const abort = () => controller.abort(outerSignal.reason);
  if (outerSignal) {
    if (outerSignal.aborted) controller.abort(outerSignal.reason);
    else outerSignal.addEventListener("abort", abort, { once: true });
  }
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    if (outerSignal) outerSignal.removeEventListener("abort", abort);
  }
}

async function resolveChecksum(source, fetchImpl, signal) {
  if (!source.checksum_url) return null;
  const response = await fetchImpl(source.checksum_url, { signal });
  if (!response.ok) throw new Error(`Checksum URL failed: HTTP ${response.status}`);
  const text = await response.text();
  const match = text.match(/[a-fA-F0-9]{64}/);
  return match ? match[0].toLowerCase() : null;
}

export function pauseDownload(db, sourceId) {
  const activeDownload = active.get(sourceId);
  if (activeDownload) activeDownload.controller.abort();
  db.prepare("UPDATE downloads SET status=?, error=?, updated_at=? WHERE id=?").run("paused", "Paused by user", now(), sourceId);
  db.prepare("UPDATE sources SET status=?, updated_at=? WHERE id=?").run("paused", now(), sourceId);
  recordEvent(db, "download-pause", `Paused download ${sourceId}`, { sourceId });
  return { sourceId, status: "paused" };
}

export async function retryDownload({ db, libraryRoot, source, diskBudgetBytes = Infinity, fetchImpl = fetch }) {
  db.prepare("UPDATE downloads SET status=?, error=NULL, updated_at=? WHERE id=?").run("queued", now(), source.id);
  recordEvent(db, "download-retry", `Retrying ${source.title}`, { sourceId: source.id });
  return downloadSource({ db, libraryRoot, source, diskBudgetBytes, fetchImpl });
}

export async function downloadProfile({ db, libraryRoot, profile, sources, diskBudgetBytes = Infinity, fetchImpl = fetch, concurrency = 4 }) {
  const selected = sources.filter((source) => profile.sourceIds.includes(source.id));
  const pending = [];
  const results = [];
  for (const source of selected) {
    const row = db.prepare("SELECT status FROM sources WHERE id=?").get(source.id);
    if (row?.status === "downloaded" || row?.status === "verified" || row?.status === "indexed") {
      results.push({ sourceId: source.id, skipped: true, status: row.status });
      continue;
    }
    pending.push(source);
    db.prepare("INSERT INTO downloads (id, source_id, status, total_bytes, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status=excluded.status, total_bytes=excluded.total_bytes, error=NULL, updated_at=excluded.updated_at")
      .run(source.id, source.id, "queued", Number(source.expected_size_bytes ?? 0), now());
    db.prepare("UPDATE sources SET status=?, updated_at=? WHERE id=? AND status NOT IN ('downloaded', 'verified', 'indexed')")
      .run("queued", now(), source.id);
  }
  const existingBytes = await currentLibraryBytesIfBudgeted(libraryRoot, diskBudgetBytes);
  const expectedBytes = pending.reduce((sum, source) => sum + Number(source.expected_size_bytes ?? 0), 0);
  if (hasDiskBudget(diskBudgetBytes) && existingBytes + expectedBytes > diskBudgetBytes) {
    const message = `Disk budget exceeded: current ${existingBytes} + profile expected ${expectedBytes} > ${diskBudgetBytes}`;
    for (const source of pending) {
      db.prepare("UPDATE downloads SET status=?, error=?, updated_at=? WHERE id=?").run("failed", message, now(), source.id);
      db.prepare("UPDATE sources SET status=?, updated_at=? WHERE id=?").run("broken", now(), source.id);
    }
    throw new Error(message);
  }
  const limit = Math.max(1, Math.min(Number(concurrency) || 4, pending.length || 1));
  recordEvent(db, "profile-download-start", `${profile.title} profile download started`, { profileId: profile.id, count: selected.length, concurrency: limit });
  const failures = [];
  let cursor = 0;
  async function worker() {
    while (cursor < pending.length) {
      const source = pending[cursor++];
      try {
        results.push(await downloadSource({ db, libraryRoot, source, diskBudgetBytes, fetchImpl }));
      } catch (error) {
        failures.push({ sourceId: source.id, error: String(error.message ?? error) });
      }
    }
  }
  await Promise.all(Array.from({ length: limit }, () => worker()));
  if (failures.length) {
    recordEvent(db, "profile-download-failed", `${profile.title} profile download finished with failures`, { profileId: profile.id, count: results.length, failures });
    throw new Error(`${failures.length} profile downloads failed: ${failures.map((failure) => `${failure.sourceId}: ${failure.error}`).join("; ")}`);
  }
  recordEvent(db, "profile-download", `${profile.title} profile download completed`, { profileId: profile.id, count: results.length, concurrency: limit });
  return { profileId: profile.id, results };
}

function hasDiskBudget(value) {
  return Number.isFinite(value) && value > 0;
}

async function currentLibraryBytesIfBudgeted(root, diskBudgetBytes) {
  return hasDiskBudget(diskBudgetBytes) ? currentLibraryBytes(root) : 0;
}

export async function verifySource({ db, libraryRoot, sourceId }) {
  const row = db.prepare("SELECT * FROM sources WHERE id=?").get(sourceId);
  if (!row?.local_path) throw new Error(`Source ${sourceId} is not downloaded`);
  const full = path.join(libraryRoot, row.local_path);
  const digest = await sha256File(full);
  const ok = !row.sha256 || row.sha256 === digest;
  db.prepare("UPDATE sources SET status=?, sha256=?, updated_at=? WHERE id=?").run(ok ? "verified" : "broken", digest, now(), sourceId);
  return { sourceId, ok, sha256: digest };
}
