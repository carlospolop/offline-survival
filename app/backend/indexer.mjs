import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { now } from "./state.mjs";

const textExtensions = new Set([".txt", ".md", ".markdown", ".csv", ".json", ".html", ".htm"]);
const epubTextExtensions = new Set([".xhtml", ".xml", ...textExtensions]);
const extractableBinaryExtensions = new Set([".pdf"]);
const zimTextMimePattern = /^(text\/|application\/xhtml\+xml|application\/xml|application\/json)/i;
const zimMaxEntryBytes = Number(process.env.SCA_ZIM_MAX_ENTRY_BYTES ?? 50 * 1024 * 1024);
const zimMaxEntries = Number(process.env.SCA_ZIM_MAX_ENTRIES ?? 0);

export async function normalizeAndIndex({ db, libraryRoot, sourceId, sourceConfig = null }) {
  const source = db.prepare("SELECT * FROM sources WHERE id=?").get(sourceId);
  if (!source?.local_path) throw new Error(`Source ${sourceId} is not downloaded`);
  const fullPath = path.join(libraryRoot, source.local_path);
  await clearSourceIndex({ db, libraryRoot, sourceId });
  if (source.type === "zim" || path.extname(fullPath).toLowerCase() === ".zim") {
    try {
      return await normalizeAndIndexZim({ db, libraryRoot, source, sourceConfig, sourceId, fullPath });
    } catch (error) {
      return await registerOriginalOnlyIndex({
        db,
        libraryRoot,
        source,
        sourceConfig,
        sourceId,
        note: `ZIM full-text extraction failed: ${String(error.message ?? error)}. The source remains openable through Kiwix.`
      });
    }
  }
  const extracted = await extractSourceText({ libraryRoot, source, sourceConfig, fullPath });
  if (!extracted.supported) {
    return await registerOriginalOnlyIndex({ db, libraryRoot, source, sourceConfig, sourceId, note: "Original reader source registered; full-text extraction is not available for this format." });
  }
  const files = extracted.files ?? [{ path: extracted.path ?? source.local_path, text: extracted.text ?? "" }];
  const text = files.map((file) => file.text).join("\n\n");
  if (!text.trim()) {
    return await registerOriginalOnlyIndex({ db, libraryRoot, source, sourceConfig, sourceId, note: "No extractable text was found; original remains openable." });
  }
  const normalized = files.map((file) => `# ${file.path}\n\n${stripMarkup(file.text)}`).join("\n\n");
  const textRel = path.join("normalized/text", `${sourceId}.txt`);
  const textPath = path.join(libraryRoot, textRel);
  await fs.writeFile(textPath, normalized);
  const chunks = [];
  for (const file of files) {
    const clean = stripMarkup(file.text);
    for (const body of chunkText(clean)) {
      const index = chunks.length;
      chunks.push({
        id: `${sourceId}:${index}`,
        source_id: sourceId,
        title: source.title,
        path: file.path,
        body,
        vector: embedText(body)
      });
    }
  }
  await fs.writeFile(path.join(libraryRoot, "chunks", `${sourceId}.jsonl`), chunks.map((chunk) => JSON.stringify(chunk)).join("\n") + "\n");
  const insertFts = db.prepare("INSERT INTO fts (source_id, title, body, path) VALUES (?, ?, ?, ?)");
  const insertChunk = db.prepare("INSERT INTO chunks (id, source_id, title, path, heading_path, body, token_estimate, vector, safety_class, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET body=excluded.body, token_estimate=excluded.token_estimate, vector=excluded.vector, created_at=excluded.created_at");
  for (const chunk of chunks) {
    insertFts.run(chunk.source_id, chunk.title, chunk.body, chunk.path);
    insertChunk.run(chunk.id, chunk.source_id, chunk.title, chunk.path, "", chunk.body, estimateTokens(chunk.body), JSON.stringify(chunk.vector), "general", now());
  }
  db.prepare("INSERT INTO documents (id, source_id, title, path, text_path, chunk_count, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET text_path=excluded.text_path, chunk_count=excluded.chunk_count, indexed_at=excluded.indexed_at")
    .run(sourceId, sourceId, source.title, extracted.path ?? source.local_path, textRel, chunks.length, now());
  db.prepare("UPDATE sources SET status=?, updated_at=? WHERE id=?").run("indexed", now(), sourceId);
  return { sourceId, documents: 1, chunks: chunks.length };
}

async function normalizeAndIndexZim({ db, libraryRoot, source, sourceId, fullPath }) {
  // libzim throws a fatal C++ exception on files smaller than the 80-byte header,
  // which bypasses JS try/catch and crashes the process. Pre-check the size.
  const stat = await fs.stat(fullPath).catch(() => null);
  if (!stat || stat.size < 80) throw new Error(`ZIM file too small (${stat?.size ?? 0} bytes)`);
  const { Archive, setClusterCacheMaxSize } = await loadLibzim();
  setClusterCacheMaxSize?.(8);
  const archive = new Archive(fullPath);
  const textRel = path.join("normalized/text", `${sourceId}.txt`);
  const textPath = path.join(libraryRoot, textRel);
  const chunkPath = path.join(libraryRoot, "chunks", `${sourceId}.jsonl`);
  await fs.mkdir(path.dirname(textPath), { recursive: true });
  await fs.mkdir(path.dirname(chunkPath), { recursive: true });

  const textStream = fsSync.createWriteStream(textPath, { encoding: "utf8" });
  const chunkStream = fsSync.createWriteStream(chunkPath, { encoding: "utf8" });
  const insertFts = db.prepare("INSERT INTO fts (source_id, title, body, path) VALUES (?, ?, ?, ?)");
  const insertChunk = db.prepare("INSERT INTO chunks (id, source_id, title, path, heading_path, body, token_estimate, vector, safety_class, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title=excluded.title, path=excluded.path, body=excluded.body, token_estimate=excluded.token_estimate, vector=excluded.vector, created_at=excluded.created_at");

  let pageCount = 0;
  let chunkCount = 0;
  let skippedLarge = 0;
  let skippedUnreadable = 0;
  let pending = [];
  let failed = null;

  try {
    for (const entry of archive.iterByPath()) {
      if (zimMaxEntries > 0 && pageCount >= zimMaxEntries) break;
      if (entry.isRedirect) continue;
      const item = readableZimItem(entry);
      if (!item) continue;
      const size = Number(item.size ?? 0);
      if (Number.isFinite(size) && size > zimMaxEntryBytes) {
        skippedLarge += 1;
        continue;
      }
      let raw;
      try {
        raw = item.data.data.toString("utf8");
      } catch {
        skippedUnreadable += 1;
        continue;
      }
      const clean = stripMarkup(raw);
      if (!clean.trim()) continue;
      pageCount += 1;
      const pageTitle = entry.title || item.title || entry.path;
      const resultPath = `${source.local_path}#${entry.path}`;
      await writeAll(textStream, `# ${pageTitle}\n${resultPath}\n\n${clean}\n\n`);
      for (const body of chunkText(clean)) {
        const title = pageTitle ? `${source.title} / ${pageTitle}` : source.title;
        const chunk = {
          id: `${sourceId}:${chunkCount}`,
          source_id: sourceId,
          title,
          path: resultPath,
          body,
          vector: embedText(body)
        };
        chunkCount += 1;
        await writeAll(chunkStream, `${JSON.stringify(chunk)}\n`);
        pending.push(chunk);
        if (pending.length >= 500) {
          flushChunks(db, insertFts, insertChunk, pending);
          pending = [];
        }
      }
    }
    if (pending.length) flushChunks(db, insertFts, insertChunk, pending);
  } catch (error) {
    failed = error;
  } finally {
    await closeStream(textStream);
    await closeStream(chunkStream);
  }

  if (failed) throw failed;
  if (!chunkCount) throw new Error("No extractable text entries were found in this ZIM");

  db.prepare("INSERT INTO documents (id, source_id, title, path, text_path, chunk_count, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET path=excluded.path, text_path=excluded.text_path, chunk_count=excluded.chunk_count, indexed_at=excluded.indexed_at")
    .run(sourceId, sourceId, source.title, source.local_path, textRel, chunkCount, now());
  db.prepare("UPDATE sources SET status=?, updated_at=? WHERE id=?").run("indexed", now(), sourceId);
  return { sourceId, documents: 1, pages: pageCount, chunks: chunkCount, skippedLarge, skippedUnreadable, zim: true };
}

export async function indexDownloadedSources({ db, libraryRoot, catalogSources = [] }) {
  const catalogById = new Map(catalogSources.map((source) => [source.id, source]));
  const rows = db.prepare(`
    SELECT s.id
    FROM sources s
    LEFT JOIN documents d ON d.source_id=s.id
    WHERE s.local_path IS NOT NULL
      AND (d.source_id IS NULL OR (s.type='zim' AND s.status='indexed-original-only'))
      AND s.status NOT IN ('missing', 'broken', 'paused')
    ORDER BY s.title
  `).all();
  const results = [];
  for (const row of rows) {
    results.push(await normalizeAndIndex({ db, libraryRoot, sourceId: row.id, sourceConfig: catalogById.get(row.id) }));
  }
  const remainingUnindexed = db.prepare(`
    SELECT s.id, s.title, s.status, s.type
    FROM sources s
    LEFT JOIN documents d ON d.source_id=s.id
    WHERE s.local_path IS NOT NULL
      AND (d.source_id IS NULL OR (s.type='zim' AND s.status='indexed-original-only'))
      AND s.status NOT IN ('missing', 'broken', 'paused')
    ORDER BY s.title
  `).all();
  return {
    indexed: results.filter((result) => result.documents > 0).length,
    registeredOriginalOnly: results.filter((result) => result.originalOnly).length,
    skipped: remainingUnindexed.length,
    remainingUnindexed,
    results
  };
}

async function registerOriginalOnlyIndex({ db, libraryRoot, source, sourceConfig, sourceId, note }) {
  const text = [
    source.title,
    source.type,
    source.license,
    sourceConfig?.description,
    Array.isArray(sourceConfig?.tags) ? sourceConfig.tags.join(" ") : "",
    note,
    "This source is downloaded and available through Open. Use Open to browse the full original content."
  ].filter(Boolean).join("\n\n");
  const textRel = path.join("normalized/text", `${sourceId}.txt`);
  await fs.writeFile(path.join(libraryRoot, textRel), text);
  const chunk = {
    id: `${sourceId}:0`,
    source_id: sourceId,
    title: source.title,
    path: source.local_path,
    body: text,
    vector: embedText(text)
  };
  db.prepare("INSERT INTO fts (source_id, title, body, path) VALUES (?, ?, ?, ?)").run(sourceId, source.title, text, source.local_path);
  db.prepare("INSERT INTO chunks (id, source_id, title, path, heading_path, body, token_estimate, vector, safety_class, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET body=excluded.body, token_estimate=excluded.token_estimate, vector=excluded.vector, created_at=excluded.created_at")
    .run(chunk.id, chunk.source_id, chunk.title, chunk.path, "", chunk.body, estimateTokens(chunk.body), JSON.stringify(chunk.vector), "original-only", now());
  db.prepare("INSERT INTO documents (id, source_id, title, path, text_path, chunk_count, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET path=excluded.path, text_path=excluded.text_path, chunk_count=excluded.chunk_count, indexed_at=excluded.indexed_at")
    .run(sourceId, sourceId, source.title, source.local_path, textRel, 1, now());
  db.prepare("UPDATE sources SET status=?, updated_at=? WHERE id=?").run("indexed-original-only", now(), sourceId);
  return { sourceId, documents: 1, chunks: 1, originalOnly: true, note };
}

async function clearSourceIndex({ db, libraryRoot, sourceId }) {
  db.prepare("DELETE FROM fts WHERE source_id=?").run(sourceId);
  db.prepare("DELETE FROM chunks WHERE source_id=?").run(sourceId);
  db.prepare("DELETE FROM documents WHERE source_id=?").run(sourceId);
  await Promise.all([
    fs.rm(path.join(libraryRoot, "normalized", "text", `${sourceId}.txt`), { force: true }),
    fs.rm(path.join(libraryRoot, "normalized", "markdown", `${sourceId}.md`), { force: true }),
    fs.rm(path.join(libraryRoot, "chunks", `${sourceId}.jsonl`), { force: true })
  ]);
}

async function extractSourceText({ libraryRoot, source, sourceConfig, fullPath }) {
  const ext = path.extname(fullPath).toLowerCase();
  if (sourceConfig?.open?.action?.startsWith("extract_") && ext === ".zip") {
    const extractDir = path.join(libraryRoot, "opened", source.id);
    await fs.mkdir(extractDir, { recursive: true });
    await extractZipToDir(fullPath, extractDir);
    const entry = sourceConfig.open.entry ?? "";
    const target = safeJoin(extractDir, entry);
    const stat = await fs.stat(target).catch(() => null);
    if (!stat) return { supported: false };
    if (stat.isDirectory()) {
      const files = await readTextDirectory(target, libraryRoot);
      return { supported: true, files, path: path.relative(libraryRoot, target) };
    }
    if (!isReadableTextPath(target)) return { supported: false };
    return {
      supported: true,
      text: await readFileText(target),
      path: path.relative(libraryRoot, target)
    };
  }
  if (ext === ".epub") return { supported: true, text: await extractEpubText(fullPath), path: source.local_path };
  if (textExtensions.has(ext) || extractableBinaryExtensions.has(ext)) return { supported: true, text: await readFileText(fullPath), path: source.local_path };
  return { supported: false };
}

function isReadableTextPath(file) {
  const ext = path.extname(file).toLowerCase();
  return textExtensions.has(ext) || extractableBinaryExtensions.has(ext) || ext === ".epub";
}

async function readFileText(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".pdf") return extractPdfText(file);
  if (ext === ".epub") return extractEpubText(file);
  return fs.readFile(file, "utf8");
}

async function readTextDirectory(dir, libraryRoot) {
  const parts = [];
  async function walk(current) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (isReadableTextPath(full)) parts.push({ path: path.relative(libraryRoot, full), text: await readFileText(full) });
    }
  }
  await walk(dir);
  return parts;
}

async function extractEpubText(file) {
  const buffer = await fs.readFile(file);
  const entries = listZipEntries(buffer);
  const parts = [];
  for (const entry of entries) {
    if (!epubTextExtensions.has(path.extname(entry.name).toLowerCase())) continue;
    try { parts.push(readZipEntry(buffer, entry).toString("utf8")); } catch { /* skip */ }
  }
  return parts.join("\n\n");
}

function listZipEntries(buffer) {
  const EOCD_SIG = 0x06054b50;
  const CD_SIG = 0x02014b50;
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65558); i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("Not a ZIP file");
  const count = buffer.readUInt16LE(eocd + 10);
  let pos = buffer.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (pos + 46 > buffer.length || buffer.readUInt32LE(pos) !== CD_SIG) break;
    const method = buffer.readUInt16LE(pos + 10);
    const compSize = buffer.readUInt32LE(pos + 20);
    const nameLen = buffer.readUInt16LE(pos + 28);
    const extraLen = buffer.readUInt16LE(pos + 30);
    const commentLen = buffer.readUInt16LE(pos + 32);
    const localOffset = buffer.readUInt32LE(pos + 42);
    const name = buffer.subarray(pos + 46, pos + 46 + nameLen).toString("utf8");
    entries.push({ name, method, compSize, localOffset });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readZipEntry(buffer, entry) {
  const LOCAL_SIG = 0x04034b50;
  const p = entry.localOffset;
  if (p + 30 > buffer.length || buffer.readUInt32LE(p) !== LOCAL_SIG) throw new Error("Bad local header");
  const nameLen = buffer.readUInt16LE(p + 26);
  const extraLen = buffer.readUInt16LE(p + 28);
  const dataStart = p + 30 + nameLen + extraLen;
  const compressed = buffer.subarray(dataStart, dataStart + entry.compSize);
  if (entry.method === 0) return compressed;
  if (entry.method === 8) return zlib.inflateRawSync(compressed);
  throw new Error(`Unsupported ZIP compression: ${entry.method}`);
}

async function extractZipToDir(zipFile, outDir) {
  const buffer = await fs.readFile(zipFile);
  const entries = listZipEntries(buffer);
  for (const entry of entries) {
    if (entry.name.endsWith("/")) continue;
    const outPath = safeJoin(outDir, entry.name);
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, readZipEntry(buffer, entry));
  }
}

export async function loadLibzim() {
  const errors = [];
  // Try ESM import first (works in dev where node_modules is intact).
  if (process.env.SCA_FORCE_LIBZIM_FALLBACK !== "1") {
    try {
      return await import("@openzim/libzim");
    } catch (error) {
      errors.push(`bare import failed: ${String(error.message ?? error)}`);
    }
  }

  // In the Tauri bundle, dist/index.js is an ES module that uses
  // `import bindings from "bindings"` — Node.js 22.x cannot require() ESM
  // without --experimental-require-module, and the bindings package's
  // __dirname heuristic breaks in a sidecar context anyway.
  // Load zim_binding.node directly by absolute path instead: native .node
  // files are always loaded as CJS regardless of the surrounding module type.
  const backendDir = path.dirname(fileURLToPath(import.meta.url));
  const searchBases = uniquePaths([
    ...splitSearchRoots(process.env.SCA_LIBZIM_SEARCH_ROOTS),
    process.env.SCA_RESOURCE_DIR,
    process.env.SCA_PACKAGED_ROOT,
    process.env.SCA_SIDECAR_DIR ? path.join(process.env.SCA_SIDECAR_DIR, "..") : "",
    path.join(backendDir, ".."),     // Resources/ in Tauri bundle
    path.join(backendDir, "../.."),  // project root in dev fallback
    process.cwd(),
    path.join(process.cwd(), ".."),
    path.join(process.cwd(), "_up_"),
    path.join(process.cwd(), "_up_/_up_")
  ]);

  const candidates = uniquePaths(searchBases.flatMap((base) => [
    path.join(base, "node_modules/@openzim/libzim/build/Release/zim_binding.node"),
    path.join(base, "_up_/node_modules/@openzim/libzim/build/Release/zim_binding.node"),
    path.join(base, "_up_/_up_/node_modules/@openzim/libzim/build/Release/zim_binding.node")
  ]));

  for (const nodeFile of candidates) {
    // Skip missing or empty placeholder files (CI creates 0-byte stubs when build is skipped).
    const isReal = await fs.stat(nodeFile).then((s) => s.size > 0, () => false);
    if (!isReal) continue;
    const libError = await missingSiblingLibzim(nodeFile);
    if (libError) {
      errors.push(libError);
      continue;
    }
    try {
      return createRequire(import.meta.url)(nodeFile);
    } catch (error) {
      errors.push(`${nodeFile}: ${String(error.message ?? error)}`);
    }
  }
  throw new Error(`@openzim/libzim could not be loaded. Checked ${candidates.length} native binding paths. ${errors.join(" | ") || "No usable zim_binding.node was found."}`);
}

function splitSearchRoots(value) {
  return String(value ?? "").split(path.delimiter).map((item) => item.trim()).filter(Boolean);
}

function uniquePaths(values) {
  const seen = new Set();
  const out = [];
  for (const value of values.filter(Boolean)) {
    const resolved = path.resolve(value);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    out.push(resolved);
  }
  return out;
}

async function missingSiblingLibzim(nodeFile) {
  const releaseDir = path.dirname(nodeFile);
  const required = process.platform === "darwin"
    ? ["libzim.9.dylib"]
    : process.platform === "linux"
      ? ["libzim.so.9"]
      : [];
  for (const name of required) {
    const file = path.join(releaseDir, name);
    const stat = await fs.stat(file).catch(() => null);
    if (!stat?.isFile() || stat.size === 0) return `${nodeFile}: missing required sibling ${name}`;
  }
  return "";
}

function readableZimItem(entry) {
  let item;
  try {
    item = entry.item;
  } catch {
    return null;
  }
  if (!zimTextMimePattern.test(String(item.mimetype ?? ""))) return null;
  return item;
}

function flushChunks(db, insertFts, insertChunk, chunks) {
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const chunk of chunks) {
      insertFts.run(chunk.source_id, chunk.title, chunk.body, chunk.path);
      insertChunk.run(chunk.id, chunk.source_id, chunk.title, chunk.path, "", chunk.body, estimateTokens(chunk.body), JSON.stringify(chunk.vector), "general", now());
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function writeAll(stream, data) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      stream.off("drain", onDrain);
      reject(error);
    };
    const onDrain = () => {
      stream.off("error", onError);
      resolve();
    };
    stream.once("error", onError);
    if (stream.write(data)) {
      stream.off("error", onError);
      resolve();
    } else {
      stream.once("drain", onDrain);
    }
  });
}

function closeStream(stream) {
  return new Promise((resolve, reject) => {
    stream.once("error", reject);
    stream.end(resolve);
  });
}

function safeJoin(root, relativePath) {
  const full = path.resolve(root, relativePath || ".");
  const resolvedRoot = path.resolve(root);
  if (full !== resolvedRoot && !full.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error(`Unsafe index path ${relativePath}`);
  return full;
}

export function semanticSearch(db, query, limit = 20) {
  const q = embedText(query);
  const rows = db.prepare("SELECT id, source_id, title, path, body, vector FROM chunks").all();
  return rows
    .map((row) => ({ ...row, score: cosine(q, JSON.parse(row.vector || "[]")) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((row) => ({
      source_id: row.source_id,
      title: row.title,
      snippet: row.body.slice(0, 260),
      path: row.path,
      score: Number(row.score.toFixed(4))
    }));
}

export function search(db, query, limit = 20, filters = {}) {
  const q = query.trim();
  if (!q) return [];
  const sql = `
    SELECT source_id, title, snippet(fts, 2, '<mark>', '</mark>', '...', 16) AS snippet, path, rank
    FROM fts
    WHERE fts MATCH ?
    ORDER BY rank
    LIMIT ?
  `;
  try {
    return filterResults(db, db.prepare(sql).all(q.replace(/"/g, ""), Math.max(limit * 4, limit)), filters).slice(0, limit);
  } catch {
    return filterResults(db, fallbackSearchRows(db, q, Math.max(limit * 4, limit)), filters).slice(0, limit);
  }
}

function fallbackSearchRows(db, query, limit) {
  const terms = query.split(/\s+/).map((term) => term.trim()).filter(Boolean).slice(0, 12);
  if (!terms.length) return [];
  const where = terms.map(() => "(body LIKE ? OR title LIKE ? OR path LIKE ?)").join(" OR ");
  const args = terms.flatMap((term) => {
    const like = `%${term}%`;
    return [like, like, like];
  });
  const candidates = db.prepare(`
    SELECT source_id, title, body, path
    FROM fts
    WHERE ${where}
    LIMIT ?
  `).all(...args, Math.max(limit * 8, limit));
  const loweredTerms = terms.map((term) => term.toLowerCase());
  const minimumMatches = terms.length > 1 ? 2 : 1;
  return candidates
    .map((row) => {
      const haystack = `${row.title}\n${row.path}\n${row.body}`.toLowerCase();
      const score = loweredTerms.reduce((sum, term) => sum + (haystack.includes(term) ? 1 : 0), 0);
      return { source_id: row.source_id, title: row.title, snippet: row.body.slice(0, 240), path: row.path, rank: -score, score };
    })
    .filter((row) => row.score >= minimumMatches)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ score, ...row }) => row);
}

function filterResults(db, rows, filters) {
  if (!filters.sourceId && !filters.license && !filters.category) return rows;
  const sources = new Map(db.prepare("SELECT id, license, type FROM sources").all().map((row) => [row.id, row]));
  return rows.filter((row) => {
    const source = sources.get(row.source_id);
    if (!source) return false;
    if (filters.sourceId && row.source_id !== filters.sourceId) return false;
    if (filters.license && source.license !== filters.license) return false;
    if (filters.category && !row.source_id.includes(filters.category) && !row.title.toLowerCase().includes(filters.category.toLowerCase())) return false;
    return true;
  });
}

export function chunkText(text, size = 2600, overlap = 250) {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const chunks = [];
  for (let start = 0; start < clean.length; start += size - overlap) {
    chunks.push(clean.slice(start, start + size));
    if (start + size >= clean.length) break;
  }
  return chunks;
}

function stripMarkup(text) {
  return text
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/[#*_`>~-]/g, " ")
    .replace(/\r/g, "");
}

function estimateTokens(text) {
  return Math.max(1, Math.ceil(text.length / 4));
}

function embedText(text, dims = 48) {
  const vector = Array(dims).fill(0);
  const words = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  for (const word of words) {
    const h = hash(word);
    const index = Math.abs(h) % dims;
    vector[index] += h % 2 === 0 ? 1 : -1;
  }
  const magnitude = Math.hypot(...vector) || 1;
  return vector.map((value) => value / magnitude);
}

function cosine(a, b) {
  if (!a.length || !b.length) return 0;
  let dot = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) dot += a[i] * b[i];
  return dot;
}

function hash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h | 0;
}

async function extractPdfText(file) {
  const PDFParse = await loadPdfParse();
  if (!PDFParse) throw new Error("pdf-parse could not be loaded; PDF indexing dependencies are missing from the app bundle.");
  const data = await fs.readFile(file);
  const parser = new PDFParse({ data });
  try {
    const result = await parser.getText();
    return (result.text ?? "")
      .replace(/--\s*\d+\s+of\s+\d+\s*--/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  } finally {
    parser.destroy();
  }
}

async function loadPdfParse() {
  // pdf-parse@2.x requires DOMMatrix / Path2D / ImageData (canvas browser APIs)
  // at module init time. Node.js does not define these globally. When @napi-rs/canvas
  // is not bundled (e.g. in the Tauri sidecar), module load throws
  // "DOMMatrix is not defined". Inject minimal stubs — text extraction never calls
  // canvas drawing methods, so the stubs are never exercised.
  if (typeof globalThis.DOMMatrix === "undefined") {
    globalThis.DOMMatrix = class DOMMatrix {
      constructor() {
        this.a=1;this.b=0;this.c=0;this.d=1;this.e=0;this.f=0;
        this.m11=1;this.m12=0;this.m13=0;this.m14=0;
        this.m21=0;this.m22=1;this.m23=0;this.m24=0;
        this.m31=0;this.m32=0;this.m33=1;this.m34=0;
        this.m41=0;this.m42=0;this.m43=0;this.m44=1;
        this.is2D=true;this.isIdentity=true;
      }
      multiply(){return this;} translate(){return this;} scale(){return this;}
      scale3d(){return this;} rotate(){return this;} rotateAxisAngle(){return this;}
      skewX(){return this;} skewY(){return this;} inverse(){return new globalThis.DOMMatrix();}
      transformPoint(p){return p||{x:0,y:0};} toString(){return "matrix(1,0,0,1,0,0)";}
      toFloat32Array(){return new Float32Array(16);} toFloat64Array(){return new Float64Array(16);}
      static fromMatrix(){return new globalThis.DOMMatrix();}
      static fromArray(){return new globalThis.DOMMatrix();}
      static fromFloat32Array(){return new globalThis.DOMMatrix();}
      static fromFloat64Array(){return new globalThis.DOMMatrix();}
    };
  }
  if (typeof globalThis.Path2D === "undefined") {
    globalThis.Path2D = class Path2D {
      constructor(){}
      moveTo(){}; lineTo(){}; closePath(){}; arc(){}; arcTo(){};
      bezierCurveTo(){}; quadraticCurveTo(){}; ellipse(){}; rect(){}; addPath(){};
    };
  }
  if (typeof globalThis.ImageData === "undefined") {
    globalThis.ImageData = class ImageData {
      constructor(w, h) { this.width=w||1; this.height=h||1; this.data=new Uint8ClampedArray((w||1)*(h||1)*4); }
    };
  }

  // Try ESM-style bare import first (dev), then CJS from bundle cwd (Tauri).
  // In the Tauri bundle: import.meta.url is inside _up_/backend/ which cannot
  // reach _up_/_up_/node_modules/ via upward traversal, but process.cwd()
  // is set to _up_/_up_/ by Rust (current_dir=catalog_root) so it finds it.
  for (const base of [import.meta.url, path.join(process.cwd(), "package.json")]) {
    try {
      const req = createRequire(base);
      return req("pdf-parse").PDFParse;
    } catch { /* try next */ }
  }
  return null;
}
