import fs from "node:fs/promises";

const file = process.argv[2];
if (!file) {
  console.error("Usage: node tools/zim-probe.mjs <file.zim>");
  process.exit(1);
}
const handle = await fs.open(file, "r");
const buffer = Buffer.alloc(80);
await handle.read(buffer, 0, buffer.length, 0);
await handle.close();
const magic = buffer.subarray(0, 4).toString("hex");
const size = (await fs.stat(file)).size;
console.log(JSON.stringify({ file, size, magic, looksLikeZim: magic === "5a494d04" || magic === "5a494d05" }, null, 2));
