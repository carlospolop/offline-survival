import fs from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";

const outDir = "app/src-tauri/icons";
await fs.mkdir(outDir, { recursive: true });
const icon32 = png(32, 32);
const icon128 = png(128, 128);
const icon256 = png(256, 256);
const icon512 = png(512, 512);
await fs.writeFile(path.join(outDir, "icon.png"), icon512);
await fs.writeFile(path.join(outDir, "32x32.png"), icon32);
await fs.writeFile(path.join(outDir, "128x128.png"), icon128);
await fs.writeFile(path.join(outDir, "128x128@2x.png"), icon256);
await fs.writeFile(path.join(outDir, "icon.ico"), ico([icon32, icon128, icon256]));
console.log("Wrote Tauri icons");

function png(width, height) {
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 4);
    row[0] = 0;
    for (let x = 0; x < width; x++) {
      const i = 1 + x * 4;
      const edge = x < 40 || y < 40 || x > width - 41 || y > height - 41;
      const diagonal = Math.abs(x - y) < 18 || Math.abs(x + y - width) < 18;
      row[i] = edge ? 36 : diagonal ? 246 : 229;
      row[i + 1] = edge ? 79 : diagonal ? 224 : 234;
      row[i + 2] = edge ? 58 : diagonal ? 138 : 223;
      row[i + 3] = 255;
    }
    rows.push(row);
  }
  const data = zlib.deflateSync(Buffer.concat(rows));
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", Buffer.concat([u32(width), u32(height), Buffer.from([8, 6, 0, 0, 0])])),
    chunk("IDAT", data),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

function chunk(type, data) {
  const name = Buffer.from(type);
  return Buffer.concat([u32(data.length), name, data, u32(crc32(Buffer.concat([name, data])))]);
}

function u32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value >>> 0);
  return buffer;
}

function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);

  const entries = [];
  let offset = header.length + images.length * 16;
  for (const image of images) {
    const { width, height } = pngSize(image);
    const entry = Buffer.alloc(16);
    entry[0] = width >= 256 ? 0 : width;
    entry[1] = height >= 256 ? 0 : height;
    entry[2] = 0;
    entry[3] = 0;
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(image.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += image.length;
  }

  return Buffer.concat([header, ...entries, ...images]);
}

function pngSize(buffer) {
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20)
  };
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
