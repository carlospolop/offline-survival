import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { sha256File } from "../app/backend/downloader.mjs";

const appImage = "app/src-tauri/target/release/bundle/appimage/Offline Survival_0.1.0_amd64.AppImage";
const sourceAppDir = "app/src-tauri/target/release/bundle/appimage/Offline Survival.AppDir";
const outRoot = "release/OfflineSurvival-Linux-x64";
const appDir = path.join(outRoot, "OfflineSurvival-App");
const checksumsDir = path.join(outRoot, "checksums");
const zipPath = "release/OfflineSurvival-Linux-x64.zip";

await fs.rm(outRoot, { recursive: true, force: true });
await fs.mkdir(appDir, { recursive: true });
await fs.mkdir(checksumsDir, { recursive: true });
const checksumLines = [];

try {
  await fs.access(appImage);
  await assertFreshAppImage(appImage);
  const portableAppImage = path.join(appDir, "Offline Survival_0.1.0_amd64.AppImage");
  const runScript = path.join(appDir, "Run-Offline-Survival.sh");
  await fs.copyFile(appImage, portableAppImage);
  await fs.chmod(portableAppImage, 0o755);
  await writeRunScript(runScript, `"${portableAppImageName()}"`);
  const checksum = await sha256File(appImage);
  checksumLines.push(`${checksum}  OfflineSurvival-App/Offline Survival_0.1.0_amd64.AppImage`);
  checksumLines.push(`${await sha256File(runScript)}  OfflineSurvival-App/Run-Offline-Survival.sh`);
  await fs.writeFile(path.join(outRoot, "README-FIRST.txt"), [
    "Offline Survival Linux Portable Package",
    "",
    "Run OfflineSurvival-App/Run-Offline-Survival.sh.",
    "The script launches the AppImage after clearing Snap-injected GTK paths that can break GUI apps.",
    "Choose or create OfflineSurvival-Library/ as the library path.",
    "All downloaded knowledge payloads stay outside the app package and remain relocatable.",
    ""
  ].join("\n"));
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
  await fs.cp(sourceAppDir, path.join(appDir, "Offline Survival.AppDir"), { recursive: true });
  await fs.chmod(path.join(appDir, "Offline Survival.AppDir", "AppRun"), 0o755);
  const runScript = path.join(appDir, "Run-Offline-Survival.sh");
  await writeRunScript(runScript, `"Offline Survival.AppDir/usr/bin/survival-civilization-archive"`);
  checksumLines.push(`${await sha256File(runScript)}  OfflineSurvival-App/Run-Offline-Survival.sh`);
  await collectChecksums(path.join(appDir, "Offline Survival.AppDir"), "OfflineSurvival-App/Offline Survival.AppDir", checksumLines);
  await fs.writeFile(path.join(outRoot, "README-FIRST.txt"), [
    "Offline Survival Linux Portable Package",
    "",
    "Run OfflineSurvival-App/Run-Offline-Survival.sh.",
    "The script launches the app after clearing Snap-injected GTK paths that can break GUI apps.",
    "Choose or create OfflineSurvival-Library/ as the library path.",
    "All downloaded knowledge payloads stay outside the app package and remain relocatable.",
    ""
  ].join("\n"));
}
await fs.writeFile(path.join(checksumsDir, "SHA256SUMS.txt"), `${checksumLines.join("\n")}\n`);
await fs.rm(zipPath, { force: true });
const result = spawnSync("zip", ["-qr", path.resolve(zipPath), "."], { cwd: outRoot, stdio: "inherit" });
if (result.status !== 0) process.exit(result.status ?? 1);
console.log(`Wrote ${zipPath}`);

function portableAppImageName() {
  return "Offline Survival_0.1.0_amd64.AppImage";
}

async function writeRunScript(scriptPath, command) {
  const script = [
    "#!/usr/bin/env sh",
    "set -eu",
    "HERE=$(CDPATH= cd -- \"$(dirname -- \"$0\")\" && pwd)",
    "unset SNAP SNAP_NAME SNAP_REVISION SNAP_ARCH SNAP_CONTEXT SNAP_COOKIE SNAP_DATA SNAP_COMMON",
    "unset SNAP_USER_DATA SNAP_USER_COMMON SNAP_REAL_HOME SNAP_LIBRARY_PATH SNAP_LAUNCHER_ARCH_TRIPLET",
    "unset SNAP_INSTANCE_NAME SNAP_UID SNAP_EUID",
    "unset GDK_PIXBUF_MODULEDIR GDK_PIXBUF_MODULE_FILE GIO_MODULE_DIR GTK_EXE_PREFIX GTK_IM_MODULE_FILE GTK_PATH",
    "export SCA_PORTABLE_APP_DIR=\"$HERE\"",
    "if [ -d \"$HERE/../OfflineSurvival-Library\" ]; then",
    "  export SCA_LIBRARY_ROOT=\"$HERE/../OfflineSurvival-Library\"",
    "fi",
    "cd \"$HERE\"",
    `exec ./${command} "$@"`,
    ""
  ].join("\n");
  await fs.writeFile(scriptPath, script);
  await fs.chmod(scriptPath, 0o755);
}

async function collectChecksums(root, relativeRoot, lines) {
  const entries = await fs.readdir(root, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    const relativePath = `${relativeRoot}/${entry.name}`;
    if (entry.isDirectory()) {
      await collectChecksums(fullPath, relativePath, lines);
    } else if (entry.isFile()) {
      lines.push(`${await sha256File(fullPath)}  ${relativePath}`);
    } else if (entry.isSymbolicLink()) {
      const target = await fs.readlink(fullPath);
      lines.push(`symlink:${target}  ${relativePath}`);
    }
  }
}

async function assertFreshAppImage(file) {
  const appImageStat = await fs.stat(file);
  const roots = [
    "app/backend",
    "app/ui/src",
    "app/src-tauri/src",
    "app/src-tauri/tauri.conf.json",
    "manifests",
    "schemas"
  ];
  const newestSource = await newestMtime(roots);
  if (newestSource > appImageStat.mtimeMs) {
    throw new Error([
      `${file} is older than source/UI/backend files.`,
      "Run npm run tauri:build before npm run package:linux-portable so the portable release contains the latest app."
    ].join(" "));
  }
}

async function newestMtime(paths) {
  let newest = 0;
  for (const item of paths) newest = Math.max(newest, await newestMtimeForPath(item));
  return newest;
}

async function newestMtimeForPath(item) {
  const stat = await fs.stat(item).catch(() => null);
  if (!stat) return 0;
  if (stat.isFile()) return stat.mtimeMs;
  if (!stat.isDirectory()) return 0;
  let newest = stat.mtimeMs;
  const entries = await fs.readdir(item, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "target" || entry.name === "node_modules" || entry.name === "vendor") continue;
    newest = Math.max(newest, await newestMtimeForPath(path.join(item, entry.name)));
  }
  return newest;
}
