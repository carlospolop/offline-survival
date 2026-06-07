import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { now } from "./state.mjs";

const textExtensions = new Set([".txt", ".md", ".markdown", ".csv", ".json", ".html", ".htm"]);
const epubTextExtensions = new Set([".xhtml", ".xml", ...textExtensions]);
const extractableBinaryExtensions = new Set([".pdf"]);
const zimTextMimePattern = /^(text\/|application\/xhtml\+xml|application\/xml|application\/json)/i;
const zimMaxEntryBytes = Number(process.env.SCA_ZIM_MAX_ENTRY_BYTES ?? 50 * 1024 * 1024);
const zimMaxEntries = Number(process.env.SCA_ZIM_MAX_ENTRIES ?? 0);
const execFileAsync = promisify(execFile);

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
    await execFileAsync("unzip", ["-oq", fullPath, "-d", extractDir], { maxBuffer: 20 * 1024 * 1024 });
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
  const { stdout } = await execFileAsync("unzip", ["-Z1", file], { maxBuffer: 20 * 1024 * 1024 });
  const entries = stdout.split(/\r?\n/).filter((name) => epubTextExtensions.has(path.extname(name).toLowerCase()));
  const parts = [];
  for (const entry of entries) {
    const { stdout: content } = await execFileAsync("unzip", ["-p", file, entry], { maxBuffer: 50 * 1024 * 1024 });
    parts.push(content);
  }
  return parts.join("\n\n");
}

async function loadLibzim() {
  try {
    return await import("@openzim/libzim");
  } catch (importError) {
    try {
      const require = createRequire(path.join(process.cwd(), "package.json"));
      return require("@openzim/libzim");
    } catch {
      throw importError;
    }
  }
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
    const like = `%${q}%`;
    return filterResults(db, db.prepare("SELECT source_id, title, substr(body, 1, 240) AS snippet, path, 0 AS rank FROM fts WHERE body LIKE ? LIMIT ?").all(like, Math.max(limit * 4, limit)), filters).slice(0, limit);
  }
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
  const buffer = await fs.readFile(file);
  const parts = [];
  const source = buffer.toString("latin1");
  const streamPattern = /<<(?:.|\n|\r)*?>>\s*stream\r?\n([\s\S]*?)\r?\nendstream/g;
  for (const match of source.matchAll(streamPattern)) {
    const headerStart = source.lastIndexOf("<<", match.index);
    const header = source.slice(headerStart, match.index);
    let payload = Buffer.from(match[1], "latin1");
    if (/FlateDecode/.test(header)) {
      try {
        payload = zlib.inflateSync(payload);
      } catch {
        continue;
      }
    }
    parts.push(extractPdfStrings(payload.toString("latin1")));
  }
  parts.push(extractPdfStrings(source));
  return parts.join("\n").replace(/\s+/g, " ").trim();
}

function extractPdfStrings(text) {
  const strings = [];
  for (const match of text.matchAll(/\((?:\\.|[^\\)])*\)\s*Tj/g)) {
    strings.push(decodePdfString(match[0].replace(/\)\s*Tj$/, "").slice(1, -1)));
  }
  for (const match of text.matchAll(/\[((?:.|\n|\r)*?)\]\s*TJ/g)) {
    for (const inner of match[1].matchAll(/\((?:\\.|[^\\)])*\)/g)) {
      strings.push(decodePdfString(inner[0].slice(1, -1)));
    }
  }
  return strings.join(" ");
}

function decodePdfString(value) {
  return value
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\\(/g, "(")
    .replace(/\\\)/g, ")")
    .replace(/\\\\/g, "\\");
}
