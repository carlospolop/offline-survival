import fs from "node:fs/promises";
import path from "node:path";
import YAML from "./vendor/yaml/browser/index.js";
import { sha256File, currentLibraryBytes } from "./downloader.mjs";
import { now, recordEvent } from "./state.mjs";

export async function writeLock({ db, libraryRoot, profile, sources }) {
  const rows = db.prepare("SELECT id, title, type, license, sha256, size_bytes, local_path, source_url, status FROM sources ORDER BY id").all();
  const selected = rows.filter((row) => profile.sourceIds.includes(row.id));
  const lock = {
    id: `${new Date().toISOString().slice(0, 10)}-${profile.id}`,
    profile_id: profile.id,
    generated_at: now(),
    sources: selected.map((row) => ({
      id: row.id,
      title: row.title,
      type: row.type,
      license: row.license,
      sha256: row.sha256,
      size_bytes: row.size_bytes,
      local_path: row.local_path,
      source_url: row.source_url,
      status: row.status
    }))
  };
  const rel = path.join("indexes", `${lock.id}.lock.yaml`);
  await fs.writeFile(path.join(libraryRoot, rel), YAML.stringify(lock));
  recordEvent(db, "lock", `Wrote profile lock ${lock.id}`, { profileId: profile.id, path: rel });
  return { path: rel, lock };
}

export async function integrityReport({ db, libraryRoot }) {
  const rows = db.prepare("SELECT id, title, sha256, local_path, status FROM sources WHERE local_path IS NOT NULL ORDER BY title").all();
  const checked = [];
  for (const row of rows) {
    const full = path.join(libraryRoot, row.local_path);
    try {
      const digest = await sha256File(full);
      checked.push({ id: row.id, title: row.title, ok: !row.sha256 || row.sha256 === digest, expected: row.sha256, actual: digest, path: row.local_path });
    } catch (error) {
      checked.push({ id: row.id, title: row.title, ok: false, expected: row.sha256, actual: null, path: row.local_path, error: String(error.message ?? error) });
    }
  }
  const ok = checked.every((item) => item.ok);
  recordEvent(db, "integrity", ok ? "Integrity check passed" : "Integrity check found problems", { checked: checked.length, ok });
  return { ok, checked, libraryBytes: await currentLibraryBytes(libraryRoot) };
}

export async function exportManifest({ db, libraryRoot }) {
  const manifest = {
    generated_at: now(),
    library_root_note: "Paths are relative to this library root.",
    sources: db.prepare("SELECT id, title, type, license, status, sha256, size_bytes, local_path, duplicate_of FROM sources ORDER BY title").all(),
    models: db.prepare("SELECT id, title, runtime, pull, role, status FROM models ORDER BY title").all(),
    documents: db.prepare("SELECT id, source_id, title, path, text_path, chunk_count FROM documents ORDER BY title").all()
  };
  const rel = "archive-manifest.json";
  await fs.writeFile(path.join(libraryRoot, rel), JSON.stringify(manifest, null, 2));
  recordEvent(db, "export", "Wrote relocatable archive manifest", { path: rel });
  return { path: rel, manifest };
}
