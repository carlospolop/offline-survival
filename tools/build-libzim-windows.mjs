/**
 * Build @openzim/libzim native addon for Windows using vcpkg-installed libzim.
 * Uses the *-windows-static-md triplet: static library linkage + dynamic CRT,
 * so zim_binding.node has no external DLL dependencies beyond Windows system DLLs.
 *
 * Run on Windows CI before `npm run sidecars:prepare`:
 *   node tools/build-libzim-windows.mjs
 *
 * Env vars:
 *   VCPKG_ROOT      - path to vcpkg root (default: C:\vcpkg)
 *   TARGET_ARCH     - 'x64' or 'arm64' (default: detected from process.arch)
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const libzimDir = path.join(projectRoot, "node_modules", "@openzim", "libzim");

const rawArch = process.env.TARGET_ARCH ?? (process.arch === "arm64" ? "arm64" : "x64");
const arch = rawArch === "arm64" ? "arm64" : "x64";

// static-md = static library linkage, dynamic CRT (/MD) — compatible with Node.js
const triplet = `${arch}-windows-static-md`;

const vcpkgRoot = process.env.VCPKG_ROOT ?? "C:\\vcpkg";
const installed  = path.join(vcpkgRoot, "installed", triplet);
const includeDir = path.join(installed, "include");
const libDir     = path.join(installed, "lib");
const libFile    = path.join(libDir, "zim.lib");
const releaseDir = path.join(libzimDir, "build", "Release");

function run(cmd, opts = {}) {
  console.log(`\n> ${cmd}`);
  execSync(cmd, { stdio: "inherit", ...opts });
}

function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath  = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// ── 1. Verify vcpkg is available ──────────────────────────────────────────────
if (!fs.existsSync(vcpkgRoot)) {
  console.error(`vcpkg not found at ${vcpkgRoot}. Set VCPKG_ROOT.`);
  process.exit(1);
}
const vcpkgExe = path.join(vcpkgRoot, "vcpkg.exe");

// ── 2. Ensure the custom triplet file exists (arm64-windows-static-md) ───────
//    vcpkg ships x64-windows-static-md but not arm64-windows-static-md.
//    Create it on the fly if missing.
if (arch === "arm64") {
  const tripletDir  = path.join(vcpkgRoot, "triplets", "community");
  const tripletFile = path.join(tripletDir, `${triplet}.cmake`);
  if (!fs.existsSync(tripletFile)) {
    fs.mkdirSync(tripletDir, { recursive: true });
    fs.writeFileSync(tripletFile, [
      "set(VCPKG_TARGET_ARCHITECTURE arm64)",
      "set(VCPKG_CRT_LINKAGE dynamic)",
      "set(VCPKG_LIBRARY_LINKAGE static)",
    ].join("\n") + "\n");
    console.log(`Created custom triplet: ${tripletFile}`);
  }
}

// ── 3. Install libzim[xapian] via vcpkg ──────────────────────────────────────
//    [xapian] feature enables full-text search and installs zim/search.h
console.log(`\nInstalling libzim[xapian]:${triplet} via vcpkg (cached on repeat runs)...`);
run(`"${vcpkgExe}" install "libzim[xapian]:${triplet}" --no-print-usage`);

if (!fs.existsSync(libFile)) {
  console.error(`vcpkg did not produce expected lib: ${libFile}`);
  process.exit(1);
}
console.log(`libzim installed (static+xapian). Lib: ${libFile}`);

// ── 4. Verify and print installed headers ────────────────────────────────────
const zimInclude = path.join(includeDir, "zim");
if (!fs.existsSync(zimInclude)) {
  console.error(`Expected zim include dir not found: ${zimInclude}`);
  process.exit(1);
}
console.log(`zim headers found at: ${zimInclude}`);
console.log(`  headers: ${fs.readdirSync(zimInclude).join(", ")}`);

if (!fs.existsSync(path.join(zimInclude, "search.h"))) {
  console.error("zim/search.h not found — xapian feature may not have been installed.");
  process.exit(1);
}

// ── 5. Copy vcpkg headers into download/include so binding.gyp finds them ────
//    binding.gyp already defines libzim_include = download/include — we
//    populate that directory from vcpkg so the EXISTING Linux/macOS conditions
//    (which reference <(libzim_include)) also work via the Windows condition.
const downloadInclude = path.join(libzimDir, "download", "include");
console.log(`\nCopying vcpkg headers → ${downloadInclude}`);
copyDirSync(includeDir, downloadInclude);
console.log("Headers copied.");

// ── 6. Enumerate ALL static .lib files for complete transitive linking ────────
//    libzim[xapian] pulls in xapian, icu, lzma, zstd as static libs.
//    node-gyp/MSBuild needs all of them listed explicitly.
const vcpkgLibFiles = fs.readdirSync(libDir)
  .filter(f => /\.lib$/i.test(f))
  .map(f => path.join(libDir, f).replace(/\\/g, "/"));

// Windows system libraries required by xapian's static dependencies:
//   ws2_32  — Winsock (socket, connect, WSACleanup, etc.)
//   rpcrt4  — RPC/UUID (UuidCreate used by xapian)
//   ucrt    — Universal CRT (POSIX aliases: unlink, rmdir, dup, write, _fstat64,
//              _ftime64, _findclose, _findfirst64i32, _findnext64i32)
const systemLibs = ["ws2_32.lib", "rpcrt4.lib", "ucrt.lib", "winmm.lib"];

const allLibFiles = [...vcpkgLibFiles, ...systemLibs];

console.log(`\nFound ${vcpkgLibFiles.length} vcpkg .lib files + ${systemLibs.length} system libs for linking:`);
allLibFiles.forEach(f => console.log(`  ${path.basename(f)}`));

// ── 7. Patch binding.gyp to add Windows conditions ───────────────────────────
const bindingGypPath = path.join(libzimDir, "binding.gyp");
const originalGyp = fs.readFileSync(bindingGypPath, "utf8");

const windowsConditions = `
              ["OS=='win'", {
                  "include_dirs": [
                    "<(libzim_include)"
                  ],
                  "libraries": ${JSON.stringify(allLibFiles)},
                  "msvs_settings": {
                    "VCCLCompilerTool": {
                      "ExceptionHandling": "1",
                      "AdditionalOptions": [ "/utf-8" ]
                    }
                  }
              }],`;

// RuntimeLibrary=2 (/MD, dynamic CRT) injected at TARGET LEVEL (outside conditions)
// so it overrides node-gyp's common.gypi which defaults to /MT (RuntimeLibrary=0).
// Must match the *-windows-static-md vcpkg triplet which also uses dynamic CRT.
// msvs_settings at target level take precedence over include-level defaults per GYP spec.
const targetMsvs = `
            "msvs_settings": {
              "VCCLCompilerTool": {
                "RuntimeLibrary": 2
              }
            },`;

// The conditions array ends just before '"target_name"'.
const marker = `],\n            "target_name"`;
if (!originalGyp.includes(marker)) {
  console.error("Cannot locate patch point in binding.gyp — structure may have changed.");
  process.exit(1);
}

const patched = originalGyp.replace(
  marker,
  `${windowsConditions}\n            ],${targetMsvs}\n            "target_name"`
);
fs.writeFileSync(bindingGypPath, patched);
console.log("Patched binding.gyp with Windows static-md conditions.");

// ── 8. Build the native addon via node-gyp ────────────────────────────────────
fs.mkdirSync(releaseDir, { recursive: true });

run(`npx node-gyp rebuild --arch=${arch}`, { cwd: libzimDir });

const nodeFile = path.join(releaseDir, "zim_binding.node");
if (!fs.existsSync(nodeFile) || fs.statSync(nodeFile).size === 0) {
  console.error(`node-gyp did not produce a valid ${nodeFile}`);
  process.exit(1);
}

console.log(`\n@openzim/libzim Windows (${arch}) native addon ready at ${nodeFile}`);
console.log("zim_binding.node is self-contained — no DLLs needed at runtime.");
