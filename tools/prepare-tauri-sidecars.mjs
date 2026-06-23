import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const binariesDir = path.resolve("app/src-tauri/binaries");
const kiwixResourceDir = path.resolve("app/src-tauri/kiwix");
const kiwixDownloadBase = process.env.KIWIX_TOOLS_BASE_URL ?? "https://download.kiwix.org/release/kiwix-tools";
const target = process.env.TAURI_TARGET_TRIPLE || process.env.TARGET || hostTriple();
const isWindowsTarget = target.includes("windows");
const exe = isWindowsTarget ? ".exe" : "";

await fs.mkdir(binariesDir, { recursive: true });
await copyNodeSidecar();
await prepareKiwixRuntime();
await ensureLibzimResourcePaths();
await ensureCanvasResourcePaths();

console.log(`Prepared Tauri sidecars for ${target}`);

async function copyNodeSidecar() {
  const destination = path.join(binariesDir, `sca-node-${target}${exe}`);
  await fs.copyFile(process.execPath, destination);
  if (!isWindowsTarget) await fs.chmod(destination, 0o755);
}

async function prepareKiwixRuntime() {
  await fs.rm(kiwixResourceDir, { recursive: true, force: true });
  await fs.mkdir(kiwixResourceDir, { recursive: true });

  if (process.env.KIWIX_SERVE_BIN) {
    const destination = path.join(kiwixResourceDir, `kiwix-serve${exe}`);
    await fs.copyFile(process.env.KIWIX_SERVE_BIN, destination);
    if (!isWindowsTarget) await fs.chmod(destination, 0o755);
    console.log(`Bundled Kiwix runtime from ${process.env.KIWIX_SERVE_BIN}`);
    return;
  }

  const plan = kiwixPlanForTarget(target);
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "offline-survival-kiwix-"));
  try {
    const archive = path.join(workDir, plan.asset);
    const extractDir = path.join(workDir, "extract");
    await downloadFile(`${kiwixDownloadBase}/${plan.asset}`, archive);
    await extractArchive(archive, extractDir, plan.kind);
    const binary = await findFile(extractDir, plan.binary);
    if (!binary) throw new Error(`Downloaded Kiwix Tools archive does not contain ${plan.binary}`);
    await copyDirectoryContents(path.dirname(binary), kiwixResourceDir);
    const runtime = path.join(kiwixResourceDir, plan.binary);
    await requireRealFile(runtime, "Kiwix runtime");
    if (!isWindowsTarget) await fs.chmod(runtime, 0o755);
    console.log(`Bundled Kiwix Tools ${plan.version} for ${target}${plan.note ? ` (${plan.note})` : ""}`);
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

function kiwixPlanForTarget(triple) {
  if (triple.includes("windows")) {
    return {
      asset: "kiwix-tools_win-x86_64-3.8.1.zip",
      binary: "kiwix-serve.exe",
      kind: "zip",
      version: "3.8.1",
      note: triple.includes("aarch64") ? "official Windows x64 package; upstream does not publish Windows ARM64 tools" : ""
    };
  }
  if (triple.includes("darwin") || triple.includes("apple")) {
    if (triple.startsWith("aarch64")) {
      return { asset: "kiwix-tools_macos-arm64-3.8.2.tar.gz", binary: "kiwix-serve", kind: "tar.gz", version: "3.8.2" };
    }
    if (triple.startsWith("x86_64")) {
      return { asset: "kiwix-tools_macos-x86_64-3.8.2.tar.gz", binary: "kiwix-serve", kind: "tar.gz", version: "3.8.2" };
    }
  }
  if (triple.includes("linux")) {
    if (triple.startsWith("aarch64")) {
      return { asset: "kiwix-tools_linux-aarch64-3.8.2.tar.gz", binary: "kiwix-serve", kind: "tar.gz", version: "3.8.2" };
    }
    if (triple.startsWith("x86_64")) {
      return { asset: "kiwix-tools_linux-x86_64-3.8.2.tar.gz", binary: "kiwix-serve", kind: "tar.gz", version: "3.8.2" };
    }
  }
  throw new Error(`No bundled Kiwix Tools package is configured for target ${triple}`);
}

async function downloadFile(url, destination) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to download ${url}: HTTP ${response.status}`);
  await fs.writeFile(destination, Buffer.from(await response.arrayBuffer()));
}

async function extractArchive(archive, destination, kind) {
  await fs.mkdir(destination, { recursive: true });
  if (kind === "tar.gz") {
    await run("tar", ["-xzf", archive, "-C", destination]);
    return;
  }
  if (kind === "zip") {
    if (process.platform === "win32") {
      await run("powershell", [
        "-NoProfile",
        "-Command",
        `Expand-Archive -LiteralPath ${powershellQuote(archive)} -DestinationPath ${powershellQuote(destination)} -Force`
      ]);
    } else {
      await run("unzip", ["-oq", archive, "-d", destination]);
    }
    return;
  }
  throw new Error(`Unsupported Kiwix archive type: ${kind}`);
}

function powershellQuote(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

async function run(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited with ${code}`));
    });
  });
}

async function findFile(root, basename) {
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isFile() && entry.name === basename) return entryPath;
    if (entry.isDirectory()) {
      const match = await findFile(entryPath, basename);
      if (match) return match;
    }
  }
  return null;
}

async function copyDirectoryContents(source, destination) {
  await fs.mkdir(destination, { recursive: true });
  const entries = await fs.readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      await copyDirectoryContents(sourcePath, destinationPath);
    } else if (entry.isFile()) {
      await fs.copyFile(sourcePath, destinationPath);
    }
  }
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
  await requireRealFile(path.join(releaseDir, "zim_binding.node"), "@openzim/libzim native binding");
  if (target.includes("linux")) {
    await requireRealFile(path.join(releaseDir, "libzim.so.9"), "Linux libzim shared library");
    await ensurePlaceholder(path.join(releaseDir, "libzim.9.dylib"));
  } else if (target.includes("darwin") || target.includes("apple")) {
    await requireRealFile(path.join(releaseDir, "libzim.9.dylib"), "macOS libzim shared library");
    await ensurePlaceholder(path.join(releaseDir, "libzim.so.9"));
  } else {
    // Windows: zim_binding.node is built by tools/build-libzim-windows.mjs using
    // static-md vcpkg linkage so it has no external DLL dependencies at runtime.
    await ensurePlaceholder(path.join(releaseDir, "libzim.so.9"));
    await ensurePlaceholder(path.join(releaseDir, "libzim.9.dylib"));
  }
}

async function ensureCanvasResourcePaths() {
  // @napi-rs/canvas loads a platform-specific native package (canvas-<platform>)
  // by name at runtime. npm installs only the package matching the build host,
  // so the other targets' directories are absent and Tauri errors on any
  // resource path that does not exist. Create empty placeholder directories for
  // the targets we did not install (mirrors the libzim placeholder handling
  // above). The real package for the current host stays intact and is the only
  // one @napi-rs/canvas ever requires; pdf-parse loads canvas in a try/catch and
  // the backend injects canvas API stubs, so targets without a published binary
  // (e.g. Windows ARM64) still work with placeholders only.
  const napiDir = path.resolve("node_modules/@napi-rs");
  const canvasPackages = [
    "canvas-darwin-arm64",
    "canvas-darwin-x64",
    "canvas-linux-arm64-gnu",
    "canvas-linux-x64-gnu",
    "canvas-win32-x64-msvc"
  ];
  await fs.mkdir(napiDir, { recursive: true });
  for (const pkg of canvasPackages) {
    const dir = path.join(napiDir, pkg);
    const installed = await fs
      .stat(path.join(dir, "package.json"))
      .then((stat) => stat.isFile(), () => false);
    if (installed) continue;
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "PLACEHOLDER.txt"),
      `Placeholder for @napi-rs/${pkg}, not installed on this build host.\n`
    );
  }
}

async function requireRealFile(file, label) {
  const stat = await fs.stat(file).catch(() => null);
  if (stat?.isFile() && stat.size > 0) return;
  throw new Error(`${label} is missing or empty: ${file}`);
}

async function ensurePlaceholder(file) {
  try {
    const stat = await fs.stat(file);
    if (stat.isFile() && stat.size > 0) return;
  } catch {
    // Create the placeholder below.
  }
  await fs.writeFile(file, "");
}
