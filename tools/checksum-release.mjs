import fs from "node:fs/promises";
import path from "node:path";
import { sha256File } from "../app/backend/downloader.mjs";

const targets = process.argv.slice(2);
if (!targets.length) {
  console.error("Usage: node tools/checksum-release.mjs <file-or-dir> [...]");
  process.exit(1);
}

const files = [];
for (const target of targets) {
  const stat = await fs.stat(target);
  if (stat.isDirectory()) {
    for (const entry of await fs.readdir(target)) files.push(path.join(target, entry));
  } else {
    files.push(target);
  }
}

for (const file of files) {
  const stat = await fs.stat(file);
  if (!stat.isFile()) continue;
  console.log(`${await sha256File(file)}  ${file}`);
}
