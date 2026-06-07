import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const binariesDir = path.resolve("app/src-tauri/binaries");
const target = process.env.TAURI_TARGET_TRIPLE || process.env.TARGET || hostTriple();
const isWindowsTarget = target.includes("windows");
const exe = isWindowsTarget ? ".exe" : "";

await fs.mkdir(binariesDir, { recursive: true });
await copyNodeSidecar();
await writeKiwixPlaceholder();
await ensureLibzimResourcePaths();

console.log(`Prepared Tauri sidecars for ${target}`);

async function copyNodeSidecar() {
  const destination = path.join(binariesDir, `sca-node-${target}${exe}`);
  await fs.copyFile(process.execPath, destination);
  if (!isWindowsTarget) await fs.chmod(destination, 0o755);
}

async function writeKiwixPlaceholder() {
  const destination = path.join(binariesDir, `kiwix-serve-${target}${exe}`);
  if (process.env.KIWIX_SERVE_BIN) {
    await fs.copyFile(process.env.KIWIX_SERVE_BIN, destination);
    if (!isWindowsTarget) await fs.chmod(destination, 0o755);
    return;
  }

  const body = isWindowsTarget
    ? "Offline Survival was built without a bundled kiwix-serve binary.\r\n"
    : [
        "#!/usr/bin/env sh",
        "echo 'Offline Survival was built without a bundled kiwix-serve binary.' >&2",
        "exit 127",
        ""
      ].join("\n");
  await fs.writeFile(destination, body);
  if (!isWindowsTarget) await fs.chmod(destination, 0o755);
}

function hostTriple() {
  const arch = os.arch() === "arm64" ? "aarch64" : os.arch() === "x64" ? "x86_64" : os.arch();
  if (process.platform === "darwin") return `${arch}-apple-darwin`;
  if (process.platform === "win32") return `${arch}-pc-windows-msvc`;
  return `${arch}-unknown-linux-gnu`;
}

async function ensureLibzimResourcePaths() {
  const releaseDir = path.resolve("node_modules/@openzim/libzim/build/Release");
  await fs.mkdir(releaseDir, { recursive: true });
  await ensureFile(path.join(releaseDir, "zim_binding.node"));
  await ensureFile(path.join(releaseDir, "libzim.so.9"));
}

async function ensureFile(file) {
  try {
    const stat = await fs.stat(file);
    if (stat.isFile()) return;
  } catch {
    // Create the placeholder below.
  }
  await fs.writeFile(file, "");
}
