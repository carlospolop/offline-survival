import fs from "node:fs/promises";
import path from "node:path";
import { loadCatalog } from "../app/backend/catalog.mjs";
import { sha256File } from "../app/backend/downloader.mjs";
import { defaultLibraryRoot, openState } from "../app/backend/state.mjs";

const args = new Map(process.argv.slice(2).map((arg) => {
  const separator = arg.indexOf("=");
  return separator < 0 ? [arg, true] : [arg.slice(0, separator), arg.slice(separator + 1)];
}));
const root = path.resolve(args.get("--root") || defaultLibraryRoot());
const verify = args.has("--verify");
const catalog = await loadCatalog();
const db = openState(root);
const checked = [];
try {
  for (const source of catalog.sources) {
    const row = db.prepare("SELECT local_path, size_bytes, sha256 FROM sources WHERE id=?").get(source.id);
    const item = { id: source.id, ok: false, bytes: 0 };
    try {
      if (!row?.local_path) throw new Error("Not downloaded");
      const file = path.join(root, row.local_path);
      const stat = await fs.stat(file);
      if (!stat.isFile() || stat.size === 0) throw new Error("Missing or empty file");
      item.bytes = stat.size;
      if (stat.size !== row.size_bytes) throw new Error("File size differs from download record");
      if (verify) {
        if (!row.sha256) throw new Error("No recorded checksum");
        if (await sha256File(file) !== row.sha256) throw new Error("Checksum mismatch");
      }
      item.ok = true;
    } catch (error) { item.error = error.message; }
    checked.push(item);
    console.log(`${item.ok ? "OK" : "FAIL"} ${item.id}${item.error ? `: ${item.error}` : ""}`);
  }
} finally { db.close(); }
const report = { generatedAt: new Date().toISOString(), root, verifiedHashes: verify, ok: checked.every((item) => item.ok), sources: checked };
await fs.mkdir(path.join(root, "logs"), { recursive: true });
await fs.writeFile(path.join(root, "logs/library-check.json"), JSON.stringify(report, null, 2));
console.log(`${checked.filter((item) => item.ok).length}/${checked.length} catalog sources present${verify ? " and checksum-verified" : ""}`);
process.exitCode = report.ok ? 0 : 1;
