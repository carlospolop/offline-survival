import fs from "node:fs/promises";
import path from "node:path";
import { now, recordEvent } from "./state.mjs";

export async function reconcileLibrary({ db, libraryRoot }) {
  const rows = db.prepare("SELECT id, title, local_path, status FROM sources ORDER BY title").all();
  const repaired = [];
  const missing = [];
  for (const row of rows) {
    if (!row.local_path) continue;
    const full = path.join(libraryRoot, row.local_path);
    try {
      await fs.access(full);
      if (row.status === "missing" || row.status === "broken") {
        db.prepare("UPDATE sources SET status=?, updated_at=? WHERE id=?").run("downloaded_unverified", now(), row.id);
        repaired.push(row.id);
      }
    } catch {
      db.prepare("UPDATE sources SET status=?, updated_at=? WHERE id=?").run("missing", now(), row.id);
      missing.push(row.id);
    }
  }
  const partials = await collectPartials(path.join(libraryRoot, "tmp"));
  for (const partial of partials) {
    db.prepare(`
      INSERT INTO downloads (id, source_id, status, bytes_received, total_bytes, error, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status=excluded.status,
        bytes_received=max(downloads.bytes_received, excluded.bytes_received),
        total_bytes=max(downloads.total_bytes, excluded.total_bytes),
        error=excluded.error,
        updated_at=excluded.updated_at
    `).run(partial.sourceId, partial.sourceId, "paused", partial.size, partial.expectedSize, "Recovered partial download", now());
  }
  recordEvent(db, "reconcile", "Reconciled library filesystem with state database", { repaired, missing, partials: partials.length });
  return { repaired, missing, partials };
}

async function collectPartials(tmpDir) {
  const entries = await fs.readdir(tmpDir, { withFileTypes: true }).catch(() => []);
  const partials = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".part")) continue;
    const full = path.join(tmpDir, entry.name);
    const sourceId = entry.name.slice(0, -".part".length);
    partials.push({ path: full, sourceId, size: (await fs.stat(full)).size, expectedSize: 0 });
  }
  return partials;
}

export async function cleanupPartials({ db, libraryRoot }) {
  const tmpDir = path.join(libraryRoot, "tmp");
  const partials = await collectPartials(tmpDir);
  for (const partial of partials) await fs.rm(partial.path, { force: true });
  db.prepare("UPDATE downloads SET status=?, updated_at=? WHERE status='paused'").run("removed", now());
  recordEvent(db, "cleanup", "Removed partial downloads", { count: partials.length });
  return { removed: partials.length };
}

export async function writeKiwixLibraryXml({ db, libraryRoot }) {
  const rows = db.prepare("SELECT id, title, local_path, sha256 FROM sources WHERE type='zim' AND local_path IS NOT NULL ORDER BY title").all();
  const books = rows.map((row) => `  <book id="${escapeXml(row.id)}" path="${escapeXml(row.local_path)}" title="${escapeXml(row.title)}" sha256="${escapeXml(row.sha256 ?? "")}" />`).join("\n");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<library version="20110515">\n${books}\n</library>\n`;
  const rel = path.join("indexes", "kiwix-library.xml");
  await fs.writeFile(path.join(libraryRoot, rel), xml);
  recordEvent(db, "kiwix", "Updated Kiwix library XML", { path: rel, count: rows.length });
  return { path: rel, count: rows.length };
}

function escapeXml(value) {
  return String(value).replace(/[<>&"']/g, (char) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "\"": "&quot;", "'": "&apos;" })[char]);
}
