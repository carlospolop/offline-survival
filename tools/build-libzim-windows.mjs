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
const libFile    = path.join(installed, "lib", "zim.lib");
const releaseDir = path.join(libzimDir, "build", "Release");

function run(cmd, opts = {}) {
  console.log(`\n> ${cmd}`);
  execSync(cmd, { stdio: "inherit", ...opts });
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

// ── 3. Install libzim via vcpkg ───────────────────────────────────────────────
console.log(`\nInstalling libzim:${triplet} via vcpkg (cached on repeat runs)...`);
run(`"${vcpkgExe}" install "libzim:${triplet}" --no-print-usage`);

if (!fs.existsSync(libFile)) {
  console.error(`vcpkg did not produce expected lib: ${libFile}`);
  process.exit(1);
}
console.log(`libzim installed (static). No DLL needed.`);

// ── 4. Patch binding.gyp to add Windows conditions ───────────────────────────
const bindingGypPath = path.join(libzimDir, "binding.gyp");
const originalGyp = fs.readFileSync(bindingGypPath, "utf8");

// GYP paths must use forward slashes
const fwdInclude = includeDir.replace(/\\/g, "/");
const fwdLib     = libFile.replace(/\\/g, "/");

const windowsConditions = `
              ["OS=='win'", {
                  "include_dirs": [
                    "${fwdInclude}"
                  ],
                  "libraries": [
                    "${fwdLib}"
                  ],
                  "msvs_settings": {
                    "VCCLCompilerTool": {
                      "ExceptionHandling": "1",
                      "AdditionalOptions": [ "/std:c++17", "/utf-8" ]
                    }
                  }
              }],`;

// The conditions array ends just before '"target_name"'.
// Find that boundary and insert Windows conditions before it.
const marker = `],\n            "target_name"`;
if (!originalGyp.includes(marker)) {
  console.error("Cannot locate patch point in binding.gyp — structure may have changed in this version.");
  process.exit(1);
}

const patched = originalGyp.replace(
  marker,
  `${windowsConditions}\n            ],\n            "target_name"`
);
fs.writeFileSync(bindingGypPath, patched);
console.log("Patched binding.gyp with Windows static-md conditions.");

// ── 5. Build the native addon via node-gyp ────────────────────────────────────
fs.mkdirSync(releaseDir, { recursive: true });

run(`npx node-gyp rebuild --arch=${arch}`, { cwd: libzimDir });

const nodeFile = path.join(releaseDir, "zim_binding.node");
if (!fs.existsSync(nodeFile) || fs.statSync(nodeFile).size === 0) {
  console.error(`node-gyp did not produce a valid ${nodeFile}`);
  process.exit(1);
}

console.log(`\n@openzim/libzim Windows (${arch}) native addon ready at ${nodeFile}`);
console.log("zim_binding.node is self-contained — no DLLs needed at runtime.");
