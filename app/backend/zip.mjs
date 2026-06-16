import fs from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const crcTable = new Uint32Array(256);

for (let n = 0; n < 256; n += 1) {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c >>> 0;
}

export function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function listZipEntries(buffer) {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65558); i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("Not a ZIP file");
  const count = buffer.readUInt16LE(eocd + 10);
  let pos = buffer.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i += 1) {
    if (pos + 46 > buffer.length || buffer.readUInt32LE(pos) !== CD_SIG) break;
    const method = buffer.readUInt16LE(pos + 10);
    const crc = buffer.readUInt32LE(pos + 16);
    const compSize = buffer.readUInt32LE(pos + 20);
    const uncompSize = buffer.readUInt32LE(pos + 24);
    const nameLen = buffer.readUInt16LE(pos + 28);
    const extraLen = buffer.readUInt16LE(pos + 30);
    const commentLen = buffer.readUInt16LE(pos + 32);
    const localOffset = buffer.readUInt32LE(pos + 42);
    const name = buffer.subarray(pos + 46, pos + 46 + nameLen).toString("utf8");
    entries.push({ name, method, crc, compSize, uncompSize, localOffset });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

export function readZipEntry(buffer, entry) {
  const p = entry.localOffset;
  if (p + 30 > buffer.length || buffer.readUInt32LE(p) !== LOCAL_SIG) throw new Error("Bad local header");
  const nameLen = buffer.readUInt16LE(p + 26);
  const extraLen = buffer.readUInt16LE(p + 28);
  const dataStart = p + 30 + nameLen + extraLen;
  const compressed = buffer.subarray(dataStart, dataStart + entry.compSize);
  if (entry.method === 0) return compressed;
  if (entry.method === 8) return zlib.inflateRawSync(compressed);
  throw new Error(`Unsupported ZIP compression: ${entry.method}`);
}

export async function estimateZipBytes(zipFile) {
  const buffer = await fs.readFile(zipFile);
  return listZipEntries(buffer).reduce((sum, entry) => sum + Number(entry.uncompSize ?? 0), 0);
}

export async function extractZipToDir(zipFile, outDir) {
  const buffer = await fs.readFile(zipFile);
  await fs.mkdir(outDir, { recursive: true });
  for (const entry of listZipEntries(buffer)) {
    if (entry.name.endsWith("/")) {
      await fs.mkdir(safeZipPath(outDir, entry.name), { recursive: true });
      continue;
    }
    const outPath = safeZipPath(outDir, entry.name);
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, readZipEntry(buffer, entry));
  }
}

export async function zipDirectoryToFile(srcDir, destPath) {
  const files = [];
  const collectFiles = async (dir) => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const relPath = path.relative(srcDir, full).split(path.sep).join("/");
      if (entry.isDirectory()) {
        files.push({ name: `${relPath}/`, data: Buffer.alloc(0) });
        await collectFiles(full);
        continue;
      }
      files.push({ name: relPath, data: await fs.readFile(full) });
    }
  };
  await collectFiles(srcDir);
  await writeZipEntries(files, destPath);
}

export async function writeZipEntries(files, destPath) {
  const locals = [];
  const chunks = [];
  let pos = 0;
  for (const { name, data } of files) {
    const nb = Buffer.from(name, "utf8");
    const comp = zlib.deflateRawSync(data, { level: 6 });
    const useComp = comp.length < data.length;
    const fd = useComp ? comp : data;
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(LOCAL_SIG, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(useComp ? 8 : 0, 8);
    lh.writeUInt32LE(0, 10);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(fd.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nb.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push({ offset: pos, nb, crc, cs: fd.length, us: data.length, method: useComp ? 8 : 0 });
    chunks.push(lh, nb, fd);
    pos += 30 + nb.length + fd.length;
  }
  const cdStart = pos;
  for (const { nb, offset, crc, cs, us, method } of locals) {
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(CD_SIG, 0);
    cd.writeUInt16LE(0x0014, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(0, 12);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(cs, 20);
    cd.writeUInt32LE(us, 24);
    cd.writeUInt16LE(nb.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    chunks.push(cd, nb);
    pos += 46 + nb.length;
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(locals.length, 8);
  eocd.writeUInt16LE(locals.length, 10);
  eocd.writeUInt32LE(pos - cdStart, 12);
  eocd.writeUInt32LE(cdStart, 16);
  chunks.push(eocd);
  await fs.writeFile(destPath, Buffer.concat(chunks));
}

function safeZipPath(root, relativePath) {
  const full = path.resolve(root, relativePath || ".");
  const resolvedRoot = path.resolve(root);
  if (full !== resolvedRoot && !full.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error(`Unsafe ZIP path ${relativePath}`);
  return full;
}
