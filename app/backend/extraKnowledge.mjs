import fs from "node:fs/promises";
import path from "node:path";
import { sha256File } from "./downloader.mjs";
import { normalizeAndIndex } from "./indexer.mjs";
import { now, recordEvent, upsertSource } from "./state.mjs";

const supported = new Map([
  [".txt", { type: "file", indexable: true }],
  [".md", { type: "file", indexable: true }],
  [".markdown", { type: "file", indexable: true }],
  [".csv", { type: "file", indexable: true }],
  [".json", { type: "file", indexable: true }],
  [".html", { type: "html", indexable: true }],
  [".htm", { type: "html", indexable: true }],
  [".pdf", { type: "pdf", indexable: true }],
  [".epub", { type: "epub", indexable: true }],
  [".zim", { type: "zim", indexable: true }]
]);

const ignoredDirectories = new Set([".git", "node_modules", "target", "dist", ".cache", ".venv", "__pycache__"]);

export function supportedExtraKnowledgeExtensions() {
  return [...supported.keys()].sort();
}

export async function scanExtraKnowledgeFolder({ folderPath, maxFiles = 5000 }) {
  const root = path.resolve(String(folderPath ?? "").trim());
  if (!root || root === path.parse(root).root) throw new Error("Choose a specific folder to scan.");
  const stat = await fs.stat(root).catch(() => null);
  if (!stat?.isDirectory()) throw new Error(`Folder does not exist or is not readable: ${root}`);

  const files = [];
  let scanned = 0;
  let skippedUnsupported = 0;
  let skippedLimit = 0;

  async function walk(current, depth = 0) {
    if (files.length >= maxFiles || depth > 16) {
      skippedLimit += 1;
      return;
    }
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".") || ignoredDirectories.has(entry.name)) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      scanned += 1;
      const ext = path.extname(entry.name).toLowerCase();
      const support = supported.get(ext);
      if (!support) {
        skippedUnsupported += 1;
        continue;
      }
      const fileStat = await fs.stat(full).catch(() => null);
      if (!fileStat?.isFile()) continue;
      files.push({
        path: full,
        name: entry.name,
        relativePath: path.relative(root, full),
        extension: ext,
        type: support.type,
        indexable: support.indexable,
        sizeBytes: fileStat.size
      });
      if (files.length >= maxFiles) break;
    }
  }

  await walk(root);
  return {
    folderPath: root,
    supportedExtensions: supportedExtraKnowledgeExtensions(),
    scanned,
    skippedUnsupported,
    skippedLimit,
    files,
    totalBytes: files.reduce((sum, file) => sum + Number(file.sizeBytes ?? 0), 0)
  };
}

export async function importExtraKnowledgeFiles({ db, libraryRoot, files = [], index = true }) {
  const uniquePaths = [...new Set(files.map((file) => path.resolve(String(file ?? "").trim())).filter(Boolean))];
  if (!uniquePaths.length) throw new Error("Select at least one supported file to import.");

  const imported = [];
  const indexed = [];
  for (const filePath of uniquePaths) {
    const source = await importOneExtraFile({ db, libraryRoot, filePath });
    imported.push(source);
    if (index) {
      indexed.push(await normalizeAndIndex({ db, libraryRoot, sourceId: source.id, sourceConfig: source }));
    }
  }
  recordEvent(db, "extra-knowledge", `Imported ${imported.length} local files`, { count: imported.length, indexed: indexed.length });
  return { imported, indexed };
}

async function importOneExtraFile({ db, libraryRoot, filePath }) {
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat?.isFile()) throw new Error(`File does not exist or is not readable: ${filePath}`);
  const ext = path.extname(filePath).toLowerCase();
  const support = supported.get(ext);
  if (!support) throw new Error(`Unsupported file type ${ext || "(no extension)"}: ${filePath}`);

  const digest = await sha256File(filePath);
  const basename = path.basename(filePath);
  const id = `extra-${digest.slice(0, 12)}-${slug(path.basename(basename, ext) || "file")}`;
  const relPath = path.join("raw", "extra", `${id}${ext}`);
  const finalPath = path.join(libraryRoot, relPath);
  await fs.mkdir(path.dirname(finalPath), { recursive: true });
  await fs.copyFile(filePath, finalPath);

  const source = {
    id,
    title: basename,
    description: `Imported local file from ${filePath}`,
    type: support.type,
    category: "extra-knowledge",
    tags: ["extra-knowledge", "local-file"],
    license: "local-user-provided",
    review_status: "approved_personal",
    license_status: "user-provided",
    runtime: sourceRuntime(support.type),
    expected_size_bytes: stat.size,
    source_url: `file://${filePath}`
  };
  upsertSource(db, source, {
    status: "downloaded",
    size_bytes: stat.size,
    sha256: digest,
    local_path: relPath
  });
  db.prepare(`
    INSERT INTO downloads (id, source_id, status, bytes_received, total_bytes, updated_at)
    VALUES (?, ?, 'complete', ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      status='complete',
      bytes_received=excluded.bytes_received,
      total_bytes=excluded.total_bytes,
      error=NULL,
      updated_at=excluded.updated_at
  `).run(id, id, stat.size, stat.size, now());
  return { ...source, status: "downloaded", size_bytes: stat.size, sha256: digest, local_path: relPath };
}

function sourceRuntime(type) {
  if (type === "zim") return ["reader", "index", "search", "local-ai"];
  return ["index", "search", "local-ai"];
}

function slug(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "file";
}
