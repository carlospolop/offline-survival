import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const dirs = [
  "raw/zim",
  "raw/pdf",
  "raw/epub",
  "raw/html",
  "raw/repos",
  "raw/models",
  "raw/runtimes",
  "raw/blobs",
  "normalized/markdown",
  "normalized/text",
  "chunks",
  "indexes",
  "services/pids",
  "logs",
  "tmp"
];
export const eventRetentionDays = 90;

export function defaultLibraryRoot() {
  const legacyName = "SurvivalCivilizationArchive";
  const appName = "OfflineSurvival";
  if (process.env.SCA_PACKAGED === "1") {
    const legacy = path.join(os.homedir(), legacyName);
    if (fsSync.existsSync(legacy)) return legacy;
    return path.join(os.homedir(), appName);
  }
  const legacy = path.resolve(process.cwd(), legacyName);
  if (fsSync.existsSync(legacy)) return legacy;
  return path.resolve(process.cwd(), appName);
}

export async function ensureLibrary(root = defaultLibraryRoot()) {
  await fs.mkdir(root, { recursive: true });
  await Promise.all(dirs.map((dir) => fs.mkdir(path.join(root, dir), { recursive: true })));
  const db = openState(root);
  migrate(db);
  db.close();
  return root;
}

export function openState(root = defaultLibraryRoot()) {
  return new DatabaseSync(path.join(root, "archive-state.sqlite"));
}

export function migrate(db) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sources (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      type TEXT NOT NULL,
      license TEXT NOT NULL,
      review_status TEXT NOT NULL DEFAULT 'candidate',
      license_status TEXT NOT NULL DEFAULT 'unverified',
      status TEXT NOT NULL,
      expected_size_bytes INTEGER NOT NULL DEFAULT 0,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      sha256 TEXT,
      local_path TEXT,
      duplicate_of TEXT,
      source_url TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS blobs (
      sha256 TEXT PRIMARY KEY,
      size_bytes INTEGER NOT NULL,
      local_path TEXT NOT NULL,
      ref_count INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS downloads (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      status TEXT NOT NULL,
      bytes_received INTEGER NOT NULL DEFAULT 0,
      total_bytes INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS services (
      name TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      pid INTEGER,
      port INTEGER,
      url TEXT,
      message TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS adapters (
      source_id TEXT PRIMARY KEY,
      adapter TEXT NOT NULL,
      status TEXT NOT NULL,
      local_url TEXT,
      port INTEGER,
      last_probe_at TEXT,
      last_error TEXT
    );
    CREATE TABLE IF NOT EXISTS models (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      runtime TEXT NOT NULL,
      pull TEXT NOT NULL,
      role TEXT NOT NULL,
      status TEXT NOT NULL,
      expected_size_bytes INTEGER NOT NULL DEFAULT 0,
      license TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      message TEXT NOT NULL,
      data TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      title TEXT NOT NULL,
      path TEXT NOT NULL,
      text_path TEXT,
      chunk_count INTEGER NOT NULL DEFAULT 0,
      indexed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS chunks (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      title TEXT NOT NULL,
      path TEXT NOT NULL,
      heading_path TEXT,
      body TEXT NOT NULL,
      token_estimate INTEGER NOT NULL,
      vector TEXT,
      safety_class TEXT,
      created_at TEXT NOT NULL
    );
  `);
  ensureSearchTable(db);
  db.exec(`
    CREATE INDEX IF NOT EXISTS documents_source_id_idx ON documents(source_id);
    CREATE INDEX IF NOT EXISTS chunks_source_id_idx ON chunks(source_id);
  `);
  addColumn(db, "sources", "review_status", "TEXT NOT NULL DEFAULT 'candidate'");
  addColumn(db, "sources", "license_status", "TEXT NOT NULL DEFAULT 'unverified'");
  addColumn(db, "sources", "duplicate_of", "TEXT");
  cleanupDuplicateDownloadRows(db);
}

function ensureSearchTable(db) {
  try {
    db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(source_id, title, body, path)");
    return;
  } catch {
    // Some bundled Node.js SQLite builds omit FTS5. Keep indexing and LIKE search
    // working everywhere instead of failing database migration at startup.
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS fts (
      source_id TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      path TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS fts_source_id_idx ON fts(source_id);
  `);
}

function addColumn(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
  if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function cleanupDuplicateDownloadRows(db) {
  const duplicateRows = db.prepare("SELECT * FROM downloads WHERE id != source_id").all();
  for (const row of duplicateRows) {
    const canonical = db.prepare("SELECT * FROM downloads WHERE id=?").get(row.source_id);
    if (canonical) {
      db.prepare(`
        UPDATE downloads
        SET bytes_received=max(bytes_received, ?),
            total_bytes=max(total_bytes, ?),
            error=coalesce(error, ?),
            updated_at=?
        WHERE id=?
      `).run(Number(row.bytes_received ?? 0), Number(row.total_bytes ?? 0), row.error ?? null, now(), row.source_id);
      db.prepare("DELETE FROM downloads WHERE id=?").run(row.id);
    } else {
      db.prepare("UPDATE downloads SET id=? WHERE id=?").run(row.source_id, row.id);
    }
  }
}

export function now() {
  return new Date().toISOString();
}

export function upsertSource(db, source, fields = {}) {
  const existing = db.prepare("SELECT status, size_bytes, sha256, local_path, duplicate_of FROM sources WHERE id=?").get(source.id);
  const status = fields.status ?? existing?.status ?? "missing";
  const sizeBytes = fields.size_bytes ?? existing?.size_bytes ?? 0;
  const sha256 = fields.sha256 ?? existing?.sha256 ?? source.sha256 ?? null;
  const localPath = fields.local_path ?? existing?.local_path ?? null;
  const duplicateOf = fields.duplicate_of ?? existing?.duplicate_of ?? null;
  const statement = db.prepare(`
    INSERT INTO sources (id, title, type, license, review_status, license_status, status, expected_size_bytes, size_bytes, sha256, local_path, duplicate_of, source_url, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title=excluded.title,
      type=excluded.type,
      license=excluded.license,
      status=excluded.status,
      expected_size_bytes=excluded.expected_size_bytes,
      size_bytes=excluded.size_bytes,
      sha256=excluded.sha256,
      local_path=excluded.local_path,
      duplicate_of=excluded.duplicate_of,
      review_status=excluded.review_status,
      license_status=excluded.license_status,
      source_url=excluded.source_url,
      updated_at=excluded.updated_at
  `);
  statement.run(
    source.id,
    source.title,
    source.type,
    source.license,
    source.review_status ?? "approved_personal",
    source.license_status ?? (source.license ? "classified" : "unverified"),
    status,
    Number(source.expected_size_bytes ?? 0),
    Number(sizeBytes),
    sha256,
    localPath,
    duplicateOf,
    source.source_url ?? source.url,
    now()
  );
}

export function upsertModel(db, model, fields = {}) {
  const existing = db.prepare("SELECT status FROM models WHERE id=?").get(model.id);
  db.prepare(`
    INSERT INTO models (id, title, runtime, pull, role, status, expected_size_bytes, license, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title=excluded.title,
      runtime=excluded.runtime,
      pull=excluded.pull,
      role=excluded.role,
      status=excluded.status,
      expected_size_bytes=excluded.expected_size_bytes,
      license=excluded.license,
      updated_at=excluded.updated_at
  `).run(model.id, model.title, model.runtime, model.pull, model.role, fields.status ?? existing?.status ?? "missing", Number(model.expected_size_bytes ?? 0), model.license ?? null, now());
}

export function removeSourcesNotInCatalog(db, catalogSources) {
  const ids = catalogSources.map((source) => source.id);
  if (!ids.length) return 0;
  const placeholders = ids.map(() => "?").join(",");
  const staleSources = db.prepare(`SELECT id FROM sources WHERE id NOT IN (${placeholders}) AND id NOT LIKE 'extra-%'`).all(...ids);
  if (!staleSources.length) return 0;
  const staleIds = staleSources.map((source) => source.id);
  const stalePlaceholders = staleIds.map(() => "?").join(",");
  db.prepare(`DELETE FROM adapters WHERE source_id IN (${stalePlaceholders})`).run(...staleIds);
  db.prepare(`DELETE FROM downloads WHERE source_id IN (${stalePlaceholders})`).run(...staleIds);
  db.prepare(`DELETE FROM documents WHERE source_id IN (${stalePlaceholders})`).run(...staleIds);
  db.prepare(`DELETE FROM chunks WHERE source_id IN (${stalePlaceholders})`).run(...staleIds);
  db.prepare(`DELETE FROM fts WHERE source_id IN (${stalePlaceholders})`).run(...staleIds);
  db.prepare(`DELETE FROM sources WHERE id IN (${stalePlaceholders})`).run(...staleIds);
  return staleIds.length;
}

export function recordEvent(db, kind, message, data = null) {
  pruneOldEvents(db);
  db.prepare("INSERT INTO events (kind, message, data, created_at) VALUES (?, ?, ?, ?)")
    .run(kind, message, data ? JSON.stringify(data) : null, now());
}

export function pruneOldEvents(db, retentionDays = eventRetentionDays) {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  return db.prepare("DELETE FROM events WHERE created_at < ?").run(cutoff).changes;
}

export async function pruneOldLogFiles(root = defaultLibraryRoot(), retentionDays = eventRetentionDays) {
  const logsDir = path.join(root, "logs");
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  let entries = [];
  try {
    entries = await fs.readdir(logsDir, { withFileTypes: true });
  } catch {
    return removed;
  }
  await Promise.all(entries.filter((entry) => entry.isFile()).map(async (entry) => {
    const file = path.join(logsDir, entry.name);
    try {
      const stat = await fs.stat(file);
      if (stat.mtimeMs >= cutoff) return;
      await fs.rm(file, { force: true });
      removed += 1;
    } catch {
      // Ignore races with services rotating logs.
    }
  }));
  return removed;
}

export function getSettings(db) {
  return Object.fromEntries(db.prepare("SELECT key, value FROM settings").all().map((row) => [row.key, JSON.parse(row.value)]));
}

export function setSetting(db, key, value) {
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, JSON.stringify(value));
}

export function markInterruptedDownloads(db) {
  const timestamp = now();
  const interrupted = db.prepare("SELECT source_id FROM downloads WHERE status IN ('queued', 'downloading', 'resuming')").all();
  if (!interrupted.length) return 0;
  db.prepare("UPDATE downloads SET status='paused', error='Interrupted before backend shutdown', updated_at=? WHERE status IN ('queued', 'downloading', 'resuming')")
    .run(timestamp);
  const updateSource = db.prepare("UPDATE sources SET status='paused', updated_at=? WHERE id=? AND status NOT IN ('downloaded', 'verified', 'indexed')");
  for (const row of interrupted) updateSource.run(timestamp, row.source_id);
  return interrupted.length;
}

export function summarizeState(db) {
  pruneOldEvents(db);
  return {
    settings: getSettings(db),
    sources: db.prepare("SELECT * FROM sources ORDER BY title").all(),
    downloads: db.prepare("SELECT * FROM downloads ORDER BY updated_at DESC").all(),
    services: db.prepare("SELECT * FROM services ORDER BY name").all(),
    adapters: db.prepare("SELECT * FROM adapters ORDER BY source_id").all(),
    models: db.prepare("SELECT * FROM models ORDER BY title").all(),
    blobs: db.prepare("SELECT * FROM blobs ORDER BY created_at DESC").all(),
    documents: db.prepare("SELECT * FROM documents ORDER BY title").all(),
    events: db.prepare("SELECT * FROM events ORDER BY created_at DESC LIMIT 100").all()
  };
}
