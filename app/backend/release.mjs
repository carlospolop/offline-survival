import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { sha256File } from "./downloader.mjs";
import { now, recordEvent, setSetting } from "./state.mjs";

const execFileAsync = promisify(execFile);

export async function writeReleaseChecksums({ db, libraryRoot, files = [] }) {
  const checksumsDir = path.join(libraryRoot, "checksums");
  await fs.mkdir(checksumsDir, { recursive: true });
  const rows = [];
  for (const file of files) {
    const stat = await fs.stat(file).catch(() => null);
    if (!stat?.isFile()) continue;
    rows.push(`${await sha256File(file)}  ${path.basename(file)}`);
  }
  const rel = path.join("checksums", `release-${new Date().toISOString().slice(0, 10)}.sha256`);
  await fs.writeFile(path.join(libraryRoot, rel), rows.join("\n") + (rows.length ? "\n" : ""));
  recordEvent(db, "release", "Wrote release checksums", { path: rel, count: rows.length });
  return { path: rel, count: rows.length, rows };
}

export async function buildPortableLayout({ db, libraryRoot }) {
  const readme = [
    "Offline Survival Portable Drive",
    "",
    "Open the app package for your operating system, then choose this library folder when prompted.",
    "The library is relocatable: raw artifacts, indexes, manifests, logs, and state use relative paths where possible.",
    "",
    "Suggested drive layout:",
    "  OfflineSurvival-App/",
    "  OfflineSurvival-Library/",
    "  checksums/",
    "",
    `Generated: ${now()}`
  ].join("\n");
  await fs.writeFile(path.join(libraryRoot, "README-FIRST.txt"), readme);
  await fs.mkdir(path.join(libraryRoot, "checksums"), { recursive: true });
  await fs.writeFile(path.join(libraryRoot, "portable-layout.json"), JSON.stringify({
    generated_at: now(),
    app_dir: "OfflineSurvival-App",
    library_dir: "OfflineSurvival-Library",
    checksums_dir: "checksums",
    localhost_only: true
  }, null, 2));
  recordEvent(db, "portable", "Wrote portable drive layout files", { root: libraryRoot });
  return { readme: "README-FIRST.txt", manifest: "portable-layout.json" };
}

export async function buildSharePackage({ db, libraryRoot, projectRoot, profile, catalogSources = [] }) {
  if (!profile?.id || !Array.isArray(profile.sourceIds) || !profile.sourceIds.length) {
    throw new Error("Choose a downloaded profile before generating a share package.");
  }
  updateShareProgress(db, {
    status: "running",
    phase: "checking",
    detail: `Checking ${profile.title} before packaging.`,
    percent: 1,
    profileId: profile.id,
    profileTitle: profile.title
  });
  const sourceAppDir = await findPortableAppDir(projectRoot);
  if (!sourceAppDir) {
    updateShareProgress(db, {
      status: "failed",
      phase: "failed",
      detail: "The portable app folder is missing. Build the portable release first, then create the share package.",
      percent: 0,
      profileId: profile.id,
      profileTitle: profile.title
    });
    throw new Error("The portable app folder is missing. Build the portable release first, then create the share package.");
  }
  const selectedSourceIds = [...new Set(profile.sourceIds)];
  const selectedSourceRows = selectedSourcesForPackage(db, selectedSourceIds, profile);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const shareRoot = path.join(libraryRoot, "share");
  const packageName = `OfflineSurvival-${slug(profile.id)}-Share-${stamp}`;
  const packageDir = path.join(shareRoot, packageName);
  const appDir = path.join(packageDir, "OfflineSurvival-App");
  const sharedLibraryDir = path.join(packageDir, "OfflineSurvival-Library");
  const archivePath = path.join(shareRoot, `${packageName}.tar.gz`);

  await fs.rm(packageDir, { recursive: true, force: true });
  await fs.mkdir(shareRoot, { recursive: true });
  db.exec("PRAGMA wal_checkpoint(FULL)");
  updateShareProgress(db, {
    status: "running",
    phase: "copy-app",
    detail: "Copying the portable app into the share package.",
    percent: 10,
    profileId: profile.id,
    profileTitle: profile.title
  });
  await fs.cp(sourceAppDir, appDir, { recursive: true, dereference: false });
  updateShareProgress(db, {
    status: "running",
    phase: "copy-library",
    detail: `Copying ${selectedSourceRows.length} downloaded sources, prepared files, and indexes.`,
    percent: 25,
    profileId: profile.id,
    profileTitle: profile.title,
    current: 0,
    total: selectedSourceRows.length
  });
  const copiedRelPaths = await copyProfileLibraryForShare({
    db,
    libraryRoot,
    target: sharedLibraryDir,
    packageDir,
    sourceRows: selectedSourceRows,
    profile
  });
  updateShareProgress(db, {
    status: "running",
    phase: "database",
    detail: "Preparing the included library database.",
    percent: 68,
    profileId: profile.id,
    profileTitle: profile.title,
    current: selectedSourceRows.length,
    total: selectedSourceRows.length
  });
  await sanitizeSharedDatabase({ dbPath: path.join(sharedLibraryDir, "archive-state.sqlite"), selectedSourceIds, copiedRelPaths, profile });
  await writeShareRunScript(path.join(appDir, "Run-Offline-Survival.sh"));
  updateShareProgress(db, {
    status: "running",
    phase: "metadata",
    detail: "Writing package manifest and launch instructions.",
    percent: 75,
    profileId: profile.id,
    profileTitle: profile.title
  });
  const manifest = await writeShareManifest({ db, libraryRoot, packageDir, packageName, profile, selectedSourceIds, catalogSources });
  const readme = await writeShareReadme({ packageDir, archiveName: path.basename(archivePath), profile });

  await fs.rm(archivePath, { force: true });
  updateShareProgress(db, {
    status: "running",
    phase: "compress",
    detail: "Compressing the share package. Large packages can stay here for a while.",
    percent: 82,
    profileId: profile.id,
    profileTitle: profile.title
  });
  await execFileAsync("tar", ["-czf", archivePath, "-C", shareRoot, packageName]);
  updateShareProgress(db, {
    status: "running",
    phase: "checksum",
    detail: "Calculating package checksum.",
    percent: 95,
    profileId: profile.id,
    profileTitle: profile.title
  });
  const checksum = await sha256File(archivePath);
  const stat = await fs.stat(archivePath);
  const checksumPath = `${archivePath}.sha256`;
  await fs.writeFile(checksumPath, `${checksum}  ${path.basename(archivePath)}\n`);
  recordEvent(db, "share-package", "Created profile share package", { archivePath, packageDir, profileId: profile.id, sourceCount: selectedSourceIds.length, sizeBytes: stat.size });
  updateShareProgress(db, {
    status: "complete",
    phase: "complete",
    detail: "Share package created.",
    percent: 100,
    profileId: profile.id,
    profileTitle: profile.title,
    archivePath,
    sizeBytes: stat.size
  });
  return {
    archivePath,
    checksumPath,
    packageDir,
    readme,
    manifest,
    profile: { id: profile.id, title: profile.title },
    checksum,
    sizeBytes: stat.size,
    instructions: [
      `Send ${archivePath} to the other computer.`,
      "Extract the archive.",
      "Run OfflineSurvival-App/Run-Offline-Survival.sh.",
      `The launcher points the app at the included OfflineSurvival-Library folder with the ${profile.title} sources automatically.`
    ]
  };
}

function selectedSourcesForPackage(db, selectedSourceIds, profile) {
  const rows = db.prepare(`SELECT * FROM sources WHERE id IN (${placeholders(selectedSourceIds)})`).all(...selectedSourceIds);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const missing = selectedSourceIds.filter((id) => {
    const row = byId.get(id);
    return !row?.local_path || ["missing", "queued", "downloading", "resuming", "paused", "failed", "broken"].includes(String(row.status ?? ""));
  });
  if (missing.length) {
    throw new Error(`Profile ${profile.title} is not fully downloaded yet. Missing or incomplete sources: ${missing.join(", ")}`);
  }
  return selectedSourceIds.map((id) => byId.get(id));
}

async function findPortableAppDir(projectRoot) {
  const candidates = [
    process.env.SCA_PORTABLE_APP_DIR,
    path.join(projectRoot, "OfflineSurvival-App"),
    path.join(projectRoot, "release", "OfflineSurvival-Linux-x64", "OfflineSurvival-App")
  ].filter(Boolean);
  for (const candidate of candidates) {
    const appDir = path.resolve(candidate);
    const stat = await fs.stat(appDir).catch(() => null);
    if (!stat?.isDirectory()) continue;
    const launcher = await fs.stat(path.join(appDir, "Run-Offline-Survival.sh")).catch(() => null);
    if (launcher?.isFile()) return appDir;
  }
  return null;
}

async function copyProfileLibraryForShare({ db, libraryRoot, target, packageDir, sourceRows, profile }) {
  await fs.rm(target, { recursive: true, force: true });
  await fs.mkdir(target, { recursive: true });
  await copyIfExists(path.join(libraryRoot, "archive-state.sqlite"), path.join(target, "archive-state.sqlite"), packageDir);

  const copiedRelPaths = new Set(["archive-state.sqlite"]);
  for (const [index, row] of sourceRows.entries()) {
    updateShareProgress(db, {
      status: "running",
      phase: "copy-library",
      detail: `Copying ${row.title}.`,
      percent: Math.min(67, 25 + Math.round(((index + 1) / Math.max(sourceRows.length, 1)) * 40)),
      profileId: profile.id,
      profileTitle: profile.title,
      current: index + 1,
      total: sourceRows.length,
      sourceId: row.id
    });
    await copyRelPath({ libraryRoot, target, packageDir, relPath: row.local_path, copiedRelPaths });
    await copyRelPath({ libraryRoot, target, packageDir, relPath: path.join("opened", row.id), copiedRelPaths });
    await copyRelPath({ libraryRoot, target, packageDir, relPath: path.join("normalized", "text", `${row.id}.txt`), copiedRelPaths });
    await copyRelPath({ libraryRoot, target, packageDir, relPath: path.join("normalized", "markdown", `${row.id}.md`), copiedRelPaths });
    await copyRelPath({ libraryRoot, target, packageDir, relPath: path.join("chunks", `${row.id}.jsonl`), copiedRelPaths });
  }
  return copiedRelPaths;
}

async function copyRelPath({ libraryRoot, target, packageDir, relPath, copiedRelPaths }) {
  if (!relPath) return false;
  const normalized = path.normalize(relPath);
  if (normalized.startsWith("..") || path.isAbsolute(normalized)) return false;
  const copied = await copyIfExists(path.join(libraryRoot, normalized), path.join(target, normalized), packageDir);
  if (copied) copiedRelPaths.add(normalized);
  return copied;
}

async function copyIfExists(source, destination, packageDir) {
  const stat = await fs.stat(source).catch(() => null);
  if (!stat || path.resolve(source).startsWith(path.resolve(packageDir))) return false;
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.cp(source, destination, { recursive: true, dereference: false });
  return true;
}

async function writeShareRunScript(scriptPath) {
  const script = [
    "#!/usr/bin/env sh",
    "set -eu",
    "HERE=$(CDPATH= cd -- \"$(dirname -- \"$0\")\" && pwd)",
    "export SCA_PORTABLE_APP_DIR=\"$HERE\"",
    "export SCA_LIBRARY_ROOT=\"$HERE/../OfflineSurvival-Library\"",
    "unset SNAP SNAP_NAME SNAP_REVISION SNAP_ARCH SNAP_CONTEXT SNAP_COOKIE SNAP_DATA SNAP_COMMON",
    "unset SNAP_USER_DATA SNAP_USER_COMMON SNAP_REAL_HOME SNAP_LIBRARY_PATH SNAP_LAUNCHER_ARCH_TRIPLET",
    "unset SNAP_INSTANCE_NAME SNAP_UID SNAP_EUID",
    "unset GDK_PIXBUF_MODULEDIR GDK_PIXBUF_MODULE_FILE GIO_MODULE_DIR GTK_EXE_PREFIX GTK_IM_MODULE_FILE GTK_PATH",
    "cd \"$HERE\"",
    "if [ -f \"Offline Survival_0.1.0_amd64.AppImage\" ]; then",
    "  exec ./\"Offline Survival_0.1.0_amd64.AppImage\" \"$@\"",
    "fi",
    "exec ./\"Offline Survival.AppDir/usr/bin/survival-civilization-archive\" \"$@\"",
    ""
  ].join("\n");
  await fs.writeFile(scriptPath, script);
  await fs.chmod(scriptPath, 0o755);
}

async function sanitizeSharedDatabase({ dbPath, selectedSourceIds, copiedRelPaths, profile }) {
  const db = new DatabaseSync(dbPath);
  try {
    const sourceSql = placeholders(selectedSourceIds);
    db.prepare(`DELETE FROM sources WHERE id NOT IN (${sourceSql})`).run(...selectedSourceIds);
    db.prepare(`DELETE FROM downloads WHERE source_id NOT IN (${sourceSql})`).run(...selectedSourceIds);
    db.prepare(`DELETE FROM adapters WHERE source_id NOT IN (${sourceSql})`).run(...selectedSourceIds);
    db.prepare(`DELETE FROM documents WHERE source_id NOT IN (${sourceSql})`).run(...selectedSourceIds);
    db.prepare(`DELETE FROM chunks WHERE source_id NOT IN (${sourceSql})`).run(...selectedSourceIds);
    db.prepare(`DELETE FROM fts WHERE source_id NOT IN (${sourceSql})`).run(...selectedSourceIds);
    db.prepare("DELETE FROM services").run();
    db.prepare("DELETE FROM models").run();

    const blobRows = db.prepare("SELECT sha256, local_path FROM blobs").all();
    for (const row of blobRows) {
      if (!copiedRelPaths.has(path.normalize(row.local_path))) db.prepare("DELETE FROM blobs WHERE sha256=?").run(row.sha256);
    }
    db.prepare(`
      INSERT INTO settings (key, value)
      VALUES ('shareProfile', ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value
    `).run(JSON.stringify({ id: profile.id, title: profile.title, generated_at: now() }));
    db.exec("PRAGMA wal_checkpoint(FULL)");
  } finally {
    db.close();
  }
}

async function writeShareManifest({ db, libraryRoot, packageDir, packageName, profile, selectedSourceIds, catalogSources }) {
  const sourceSql = placeholders(selectedSourceIds);
  const catalogById = new Map(catalogSources.map((source) => [source.id, source]));
  const manifest = {
    package: packageName,
    generated_at: now(),
    profile: {
      id: profile.id,
      title: profile.title,
      description: profile.description,
      sourceIds: selectedSourceIds
    },
    library_source: libraryRoot,
    app_dir: "OfflineSurvival-App",
    library_dir: "OfflineSurvival-Library",
    sources: db.prepare(`SELECT id, title, type, license, status, size_bytes, local_path FROM sources WHERE id IN (${sourceSql}) ORDER BY title`).all(...selectedSourceIds)
      .map((source) => ({ ...source, description: catalogById.get(source.id)?.description })),
    documents: db.prepare(`SELECT id, source_id, title, path, text_path, chunk_count FROM documents WHERE source_id IN (${sourceSql}) ORDER BY title`).all(...selectedSourceIds)
  };
  const rel = "share-manifest.json";
  await fs.writeFile(path.join(packageDir, rel), JSON.stringify(manifest, null, 2));
  return rel;
}

async function writeShareReadme({ packageDir, archiveName, profile }) {
  const rel = "README-FIRST.txt";
  await fs.writeFile(path.join(packageDir, rel), [
    "Offline Survival Share Package",
    "",
    `This package contains the application and the downloaded sources for the ${profile.title} profile.`,
    "",
    "How to share:",
    `1. Send ${archiveName} to the other computer.`,
    "2. Extract it.",
    "3. Run OfflineSurvival-App/Run-Offline-Survival.sh.",
    "",
    "The launcher automatically uses the included OfflineSurvival-Library folder.",
    "No internet connection is required for already downloaded and prepared sources.",
    "",
    "License note: only redistribute sources whose licenses allow sharing.",
    ""
  ].join("\n"));
  return rel;
}

function placeholders(values) {
  if (!values.length) throw new Error("Expected at least one selected source.");
  return values.map(() => "?").join(",");
}

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "profile";
}

function updateShareProgress(db, progress) {
  setSetting(db, "sharePackageProgress", { ...progress, updatedAt: Date.now() });
}
