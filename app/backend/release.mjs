import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { sha256File } from "./downloader.mjs";
import { now, recordEvent, setSetting } from "./state.mjs";

const execFileAsync = promisify(execFile);
const defaultShareCopyConcurrency = Math.max(1, Number(process.env.SCA_SHARE_COPY_CONCURRENCY ?? Math.min(8, Math.max(2, os.cpus().length))));

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

export async function buildSharePackage({ db, libraryRoot, projectRoot, profile, catalogSources = [], appBundlePath = "" }) {
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
  const primaryOs = normalizePrimaryOs(profile.primaryOs ?? profile.targetOs ?? profile.os);
  const appSources = await findShareAppSources(projectRoot, appBundlePath, primaryOs);
  if (!appSources.length) {
    updateShareProgress(db, {
      status: "failed",
      phase: "failed",
      detail: `No ${primaryOs} app release artifact was found. Build the selected OS release before creating the share package.`,
      percent: 0,
      profileId: profile.id,
      profileTitle: profile.title
    });
    throw new Error(`No ${primaryOs} app release artifact was found. Build the selected OS release before creating the share package.`);
  }
  const selectedSourceIds = [...new Set(profile.sourceIds)];
  const selectedSourceRows = selectedSourcesForPackage(db, selectedSourceIds, profile);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const shareRoot = path.join(libraryRoot, "share");
  const packageName = `OfflineSurvival-${slug(profile.id)}-Share-${stamp}`;
  const packageDir = path.join(shareRoot, packageName);
  const appsDir = path.join(packageDir, "OfflineSurvival-Apps");
  const sharedLibraryDir = path.join(packageDir, "OfflineSurvival-Library");
  const archivePath = path.join(shareRoot, `${packageName}.tar.gz`);

  await fs.rm(packageDir, { recursive: true, force: true });
  await fs.mkdir(shareRoot, { recursive: true });
  db.exec("PRAGMA wal_checkpoint(FULL)");
  updateShareProgress(db, {
    status: "running",
    phase: "copy-app",
    detail: `Copying ${primaryOs} app release artifact into the share package.`,
    percent: 10,
    profileId: profile.id,
    profileTitle: profile.title
  });
  const copiedApps = await copyShareApps({ appSources, appsDir });
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
  const launchers = await writeShareLaunchers({ packageDir, primaryOs, apps: copiedApps });
  updateShareProgress(db, {
    status: "running",
    phase: "metadata",
    detail: "Writing package manifest and launch instructions.",
    percent: 75,
    profileId: profile.id,
    profileTitle: profile.title
  });
  const manifest = await writeShareManifest({ db, libraryRoot, packageDir, packageName, profile, selectedSourceIds, catalogSources, primaryOs, apps: copiedApps, launchers });
  const readme = await writeShareReadme({ packageDir, archiveName: path.basename(archivePath), profile, primaryOs, apps: copiedApps });

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
  recordEvent(db, "share-package", "Created profile share package", { archivePath, packageDir, profileId: profile.id, sourceCount: selectedSourceIds.length, sizeBytes: stat.size, primaryOs, appCount: copiedApps.length });
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
    apps: copiedApps,
    primaryOs,
    launchers,
    profile: { id: profile.id, title: profile.title },
    checksum,
    sizeBytes: stat.size,
    instructions: [
      `Send ${archivePath} to the other computer.`,
      "Extract the archive.",
      launcherInstruction(primaryOs),
      `The package includes the ${profile.title} sources in OfflineSurvival-Library and the ${primaryOs} app artifact.`
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

async function findShareAppSources(projectRoot, appBundlePath = "", primaryOs = "") {
  const candidates = [
    appBundlePath ? path.resolve(appBundlePath) : "",
    process.env.SCA_SHARE_APPS_DIR,
    process.env.SCA_ALL_PLATFORM_APP_DIR,
    currentPackagedAppBundle(),
    path.join(projectRoot, "release", "all-platforms", "Offline-Survival-all-platforms"),
    path.join(projectRoot, "release", "Offline-Survival-all-platforms"),
    path.join(projectRoot, "app", "src-tauri", "target", "release", "bundle", "dmg"),
    path.join(projectRoot, "app", "src-tauri", "target", "release", "bundle", "appimage"),
    path.join(projectRoot, "app", "src-tauri", "target", "release", "bundle", "msi"),
    path.join(projectRoot, "app", "src-tauri", "target", "release", "bundle", "nsis"),
    path.join(projectRoot, "downloaded-artifacts"),
    path.join(projectRoot, "release"),
    projectRoot
  ].filter(Boolean);
  const seen = new Set();
  const apps = [];
  const selectedPlatform = normalizePrimaryOs(primaryOs);
  for (const candidate of candidates) {
    const root = path.resolve(candidate);
    const stat = await fs.stat(root).catch(() => null);
    if (!stat) continue;
    if (stat.isFile()) {
      const parsed = parseReleaseArtifactFile(root);
      if (!parsed || parsed.platform !== selectedPlatform) continue;
      const key = `${parsed.platform}-${parsed.arch}-${root}`;
      if (!seen.has(key)) {
        seen.add(key);
        apps.push({ ...parsed, sourceDir: root });
      }
      continue;
    }
    if (!stat.isDirectory()) continue;
    const direct = parseReleaseAppFolder(path.basename(root)) ?? parseReleaseArtifactDirectory(root);
    if (direct) {
      if (direct.platform !== selectedPlatform) continue;
      const key = `${direct.platform}-${direct.arch}-${root}`;
      if (!seen.has(key)) {
        seen.add(key);
        apps.push({ ...direct, sourceDir: root });
      }
    }
    for (const entry of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
      const sourceDir = path.join(root, entry.name);
      const parsed = entry.isDirectory() ? (parseReleaseAppFolder(entry.name) ?? parseReleaseArtifactDirectory(sourceDir)) : parseReleaseArtifactFile(sourceDir);
      if (!parsed) continue;
      if (parsed.platform !== selectedPlatform) continue;
      const key = `${parsed.platform}-${parsed.arch}-${sourceDir}`;
      if (seen.has(key)) continue;
      seen.add(key);
      apps.push({ ...parsed, sourceDir });
    }
  }
  const legacy = await findLegacyPortableAppDir(projectRoot);
  if (selectedPlatform === "linux" && legacy && !apps.some((app) => app.platform === "linux" && app.arch === "x64")) {
    apps.push({ label: "linux-x64", platform: "linux", arch: "x64", sourceDir: legacy });
  }
  return apps.sort((a, b) => `${a.platform}-${a.arch}`.localeCompare(`${b.platform}-${b.arch}`));
}

function currentPackagedAppBundle() {
  const resourceDir = process.env.SCA_RESOURCE_DIR;
  if (!resourceDir || process.platform !== "darwin") return "";
  return path.resolve(resourceDir, "..", "..");
}

async function findLegacyPortableAppDir(projectRoot) {
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
    const appImage = await fs.stat(path.join(appDir, "Offline Survival_0.1.0_amd64.AppImage")).catch(() => null);
    if (launcher?.isFile() || appImage?.isFile()) return appDir;
  }
  return null;
}

function parseReleaseAppFolder(name) {
  const match = /^Offline-Survival-(linux|windows|macos)-(x64|arm64)$/.exec(name);
  if (!match) return null;
  return { label: `${match[1]}-${match[2]}`, platform: match[1], arch: match[2] };
}

function parseReleaseArtifactFile(filePath) {
  const name = path.basename(filePath);
  const arch = /(?:aarch64|arm64)/i.test(name) ? "arm64" : "x64";
  if (/\.dmg$/i.test(name) || /\.app\.tar\.gz$/i.test(name)) return { label: `macos-${arch}`, platform: "macos", arch };
  if (/\.appimage$/i.test(name) || /\.(?:deb|rpm)$/i.test(name)) return { label: `linux-${arch}`, platform: "linux", arch };
  if (/\.(?:msi|exe)$/i.test(name)) return { label: `windows-${arch}`, platform: "windows", arch };
  return null;
}

function parseReleaseArtifactDirectory(dirPath) {
  const name = path.basename(dirPath);
  if (!/\.app$/i.test(name)) return null;
  return { label: `macos-${runtimeArchLabel()}`, platform: "macos", arch: runtimeArchLabel() };
}

function runtimeArchLabel() {
  return process.arch === "arm64" ? "arm64" : "x64";
}

async function copyShareApps({ appSources, appsDir }) {
  await fs.rm(appsDir, { recursive: true, force: true });
  const copied = await mapLimit(appSources, defaultShareCopyConcurrency, async (app) => {
    const destination = path.join(appsDir, app.label);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    const stat = await fs.stat(app.sourceDir);
    if (stat.isDirectory()) {
      if (/\.app$/i.test(path.basename(app.sourceDir))) {
        await fs.mkdir(destination, { recursive: true });
        await fs.cp(app.sourceDir, path.join(destination, path.basename(app.sourceDir)), { recursive: true, dereference: false });
      } else {
        await fs.cp(app.sourceDir, destination, { recursive: true, dereference: false });
      }
    } else {
      await fs.mkdir(destination, { recursive: true });
      await fs.cp(app.sourceDir, path.join(destination, path.basename(app.sourceDir)), { dereference: false });
    }
    return {
      label: app.label,
      platform: app.platform,
      arch: app.arch,
      path: path.relative(path.dirname(appsDir), destination)
    };
  });
  return copied;
}

async function copyProfileLibraryForShare({ db, libraryRoot, target, packageDir, sourceRows, profile }) {
  await fs.rm(target, { recursive: true, force: true });
  await fs.mkdir(target, { recursive: true });
  await copyIfExists(path.join(libraryRoot, "archive-state.sqlite"), path.join(target, "archive-state.sqlite"), packageDir);

  const copiedRelPaths = new Set(["archive-state.sqlite"]);
  const copyTasks = new Map();
  let started = 0;
  await mapLimit(sourceRows, defaultShareCopyConcurrency, async (row) => {
    started += 1;
    const current = started;
    updateShareProgress(db, {
      status: "running",
      phase: "copy-library",
      detail: `Copying ${row.title}.`,
      percent: Math.min(67, 25 + Math.round((current / Math.max(sourceRows.length, 1)) * 40)),
      profileId: profile.id,
      profileTitle: profile.title,
      current,
      total: sourceRows.length,
      sourceId: row.id
    });
    await Promise.all([
      copyRelPath({ libraryRoot, target, packageDir, relPath: row.local_path, copiedRelPaths, copyTasks }),
      copyRelPath({ libraryRoot, target, packageDir, relPath: path.join("opened", row.id), copiedRelPaths, copyTasks }),
      copyRelPath({ libraryRoot, target, packageDir, relPath: path.join("normalized", "text", `${row.id}.txt`), copiedRelPaths, copyTasks }),
      copyRelPath({ libraryRoot, target, packageDir, relPath: path.join("normalized", "markdown", `${row.id}.md`), copiedRelPaths, copyTasks }),
      copyRelPath({ libraryRoot, target, packageDir, relPath: path.join("chunks", `${row.id}.jsonl`), copiedRelPaths, copyTasks })
    ]);
  });
  return copiedRelPaths;
}

async function copyRelPath({ libraryRoot, target, packageDir, relPath, copiedRelPaths, copyTasks = null }) {
  if (!relPath) return false;
  const normalized = path.normalize(relPath);
  if (normalized.startsWith("..") || path.isAbsolute(normalized)) return false;
  if (copyTasks?.has(normalized)) return copyTasks.get(normalized);
  const task = copyIfExists(path.join(libraryRoot, normalized), path.join(target, normalized), packageDir);
  copyTasks?.set(normalized, task);
  const copied = await task;
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

async function mapLimit(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(items.length, Math.max(1, Number(concurrency) || 1));
  async function worker() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

async function writeShareRunScript(scriptPath, appLabel = "linux-x64") {
  const script = [
    "#!/usr/bin/env sh",
    "set -eu",
    "HERE=$(CDPATH= cd -- \"$(dirname -- \"$0\")\" && pwd)",
    `APP_DIR="$HERE/OfflineSurvival-Apps/${appLabel}"`,
    "export SCA_PORTABLE_APP_DIR=\"$APP_DIR\"",
    "export SCA_LIBRARY_ROOT=\"$HERE/OfflineSurvival-Library\"",
    "unset SNAP SNAP_NAME SNAP_REVISION SNAP_ARCH SNAP_CONTEXT SNAP_COOKIE SNAP_DATA SNAP_COMMON",
    "unset SNAP_USER_DATA SNAP_USER_COMMON SNAP_REAL_HOME SNAP_LIBRARY_PATH SNAP_LAUNCHER_ARCH_TRIPLET",
    "unset SNAP_INSTANCE_NAME SNAP_UID SNAP_EUID",
    "unset GDK_PIXBUF_MODULEDIR GDK_PIXBUF_MODULE_FILE GIO_MODULE_DIR GTK_EXE_PREFIX GTK_IM_MODULE_FILE GTK_PATH",
    "cd \"$APP_DIR\"",
    "APPIMAGE=$(find . -maxdepth 2 -type f -name '*.AppImage' | head -n 1)",
    "if [ -n \"$APPIMAGE\" ]; then",
    "  chmod +x \"$APPIMAGE\" 2>/dev/null || true",
    "  exec \"$APPIMAGE\" \"$@\"",
    "fi",
    "if [ -x \"Offline Survival.AppDir/usr/bin/survival-civilization-archive\" ]; then",
    "  exec ./\"Offline Survival.AppDir/usr/bin/survival-civilization-archive\" \"$@\"",
    "fi",
    "echo 'No Linux executable was found in' \"$APP_DIR\" >&2",
    "echo 'Open the .deb or .rpm installer from that folder, then select OfflineSurvival-Library as the library path.' >&2",
    "exit 1",
    ""
  ].join("\n");
  await fs.writeFile(scriptPath, script);
  await fs.chmod(scriptPath, 0o755);
}

async function writeShareLaunchers({ packageDir, primaryOs, apps }) {
  const launchers = [];
  const linux = chooseApp(apps, "linux");
  if (linux) {
    await writeShareRunScript(path.join(packageDir, "Run-Offline-Survival-Linux.sh"), linux.label);
    launchers.push("Run-Offline-Survival-Linux.sh");
  }
  const windows = chooseApp(apps, "windows");
  if (windows) {
    const script = [
      "@echo off",
      "setlocal",
      "set HERE=%~dp0",
      "set SCA_LIBRARY_ROOT=%HERE%OfflineSurvival-Library",
      `set APP_DIR=%HERE%OfflineSurvival-Apps\\${windows.label}`,
      "for %%F in (\"%APP_DIR%\\*.exe\") do start \"Offline Survival\" \"%%~fF\" & exit /b 0",
      "for %%F in (\"%APP_DIR%\\*.msi\") do start \"Offline Survival installer\" \"%%~fF\" & exit /b 0",
      "echo No Windows installer or executable was found in %APP_DIR%",
      "echo After installing, choose the OfflineSurvival-Library folder when the app opens.",
      "pause",
      ""
    ].join("\r\n");
    await fs.writeFile(path.join(packageDir, "Run-Offline-Survival-Windows.bat"), script);
    launchers.push("Run-Offline-Survival-Windows.bat");
  }
  const macos = chooseApp(apps, "macos");
  if (macos) {
    const script = [
      "#!/usr/bin/env sh",
      "set -eu",
      "HERE=$(CDPATH= cd -- \"$(dirname -- \"$0\")\" && pwd)",
      `APP_DIR="$HERE/OfflineSurvival-Apps/${macos.label}"`,
      "export SCA_LIBRARY_ROOT=\"$HERE/OfflineSurvival-Library\"",
      "DMG=$(find \"$APP_DIR\" -maxdepth 2 -type f -name '*.dmg' | head -n 1)",
      "APP=$(find \"$APP_DIR\" -maxdepth 3 -type d -name '*.app' | head -n 1)",
      "if [ -n \"$APP\" ]; then open \"$APP\"; exit 0; fi",
      "if [ -n \"$DMG\" ]; then open \"$DMG\"; exit 0; fi",
      "echo 'No macOS app or dmg was found in' \"$APP_DIR\" >&2",
      "echo 'After installing, choose OfflineSurvival-Library as the library path.' >&2",
      "exit 1",
      ""
    ].join("\n");
    await fs.writeFile(path.join(packageDir, "Run-Offline-Survival-macOS.command"), script);
    await fs.chmod(path.join(packageDir, "Run-Offline-Survival-macOS.command"), 0o755);
    launchers.push("Run-Offline-Survival-macOS.command");
  }
  await fs.writeFile(path.join(packageDir, "START-HERE.txt"), startHereText({ primaryOs, apps, launchers }));
  launchers.push("START-HERE.txt");
  return launchers;
}

function chooseApp(apps, platform) {
  return apps.find((app) => app.platform === platform && app.arch === "x64")
    ?? apps.find((app) => app.platform === platform)
    ?? null;
}

function normalizePrimaryOs(value) {
  return ["windows", "macos", "linux"].includes(String(value)) ? String(value) : platformName(process.platform);
}

function platformName(value) {
  if (value === "win32") return "windows";
  if (value === "darwin") return "macos";
  return "linux";
}

function launcherInstruction(primaryOs) {
  if (primaryOs === "windows") return "On Windows, run Run-Offline-Survival-Windows.bat.";
  if (primaryOs === "macos") return "On macOS, run Run-Offline-Survival-macOS.command.";
  return "On Linux, run Run-Offline-Survival-Linux.sh.";
}

function startHereText({ primaryOs, apps, launchers }) {
  return [
    "Offline Survival Share Package",
    "",
    launcherInstruction(primaryOs),
    "",
    "Other launchers included:",
    ...launchers.map((launcher) => `- ${launcher}`),
    "",
    "Included app folders:",
    ...apps.map((app) => `- OfflineSurvival-Apps/${app.label}`),
    "",
    "Included library:",
    "- OfflineSurvival-Library",
    "",
    "If an installer opens instead of the app, install it and then choose the included OfflineSurvival-Library folder when Offline Survival asks for a library path.",
    ""
  ].join("\n");
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
    runOptionalSql(db, `DELETE FROM fts WHERE source_id NOT IN (${sourceSql})`, selectedSourceIds);
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

function runOptionalSql(db, sql, params = []) {
  try {
    db.prepare(sql).run(...params);
    return true;
  } catch (error) {
    if (String(error.message ?? error).includes("no such module: fts5")) return false;
    throw error;
  }
}

async function writeShareManifest({ db, libraryRoot, packageDir, packageName, profile, selectedSourceIds, catalogSources, primaryOs, apps, launchers }) {
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
    primary_os: primaryOs,
    apps_dir: "OfflineSurvival-Apps",
    library_dir: "OfflineSurvival-Library",
    apps,
    launchers,
    sources: db.prepare(`SELECT id, title, type, license, status, size_bytes, local_path FROM sources WHERE id IN (${sourceSql}) ORDER BY title`).all(...selectedSourceIds)
      .map((source) => ({ ...source, description: catalogById.get(source.id)?.description })),
    documents: db.prepare(`SELECT id, source_id, title, path, text_path, chunk_count FROM documents WHERE source_id IN (${sourceSql}) ORDER BY title`).all(...selectedSourceIds)
  };
  const rel = "share-manifest.json";
  await fs.writeFile(path.join(packageDir, rel), JSON.stringify(manifest, null, 2));
  return rel;
}

async function writeShareReadme({ packageDir, archiveName, profile, primaryOs, apps }) {
  const rel = "README-FIRST.txt";
  await fs.writeFile(path.join(packageDir, rel), [
    "Offline Survival Share Package",
    "",
    `This package contains app release files and the downloaded sources for the ${profile.title} profile.`,
    "",
    "How to share:",
    `1. Send ${archiveName} to the other computer.`,
    "2. Extract it.",
    `3. ${launcherInstruction(primaryOs)}`,
    "",
    "Included app folders:",
    ...apps.map((app) => `- OfflineSurvival-Apps/${app.label}`),
    "",
    "Linux launchers automatically point the app at OfflineSurvival-Library.",
    "Windows and macOS installers may need one manual step after installation: choose the included OfflineSurvival-Library folder as the library path.",
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
