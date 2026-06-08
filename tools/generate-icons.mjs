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

// All coordinates in a 64×64 virtual canvas, scaled to the target size.
function getColor(nx, ny) {
  const cr = 13;
  if (nx < cr && ny < cr && Math.hypot(nx - cr, ny - cr) > cr) return null;
  if (nx > 64 - cr && ny < cr && Math.hypot(nx - (64 - cr), ny - cr) > cr) return null;
  if (nx < cr && ny > 64 - cr && Math.hypot(nx - cr, ny - (64 - cr)) > cr) return null;
  if (nx > 64 - cr && ny > 64 - cr && Math.hypot(nx - (64 - cr), ny - (64 - cr)) > cr) return null;

  const CX = 32;

  // Torch handle
  if (ny >= 45 && ny <= 57 && nx >= 30 && nx <= 34) return [13, 80, 48];

  // Torch cup (trapezoid, wider at top)
  if (ny >= 37 && ny <= 45) {
    const t = (ny - 37) / 8;
    if (Math.abs(nx - CX) <= 10 - t * 2) return [26, 96, 64];
  }

  // Flame (teardrop shape, peaks ~65 % from top)
  if (ny >= 9 && ny <= 40) {
    const t = (ny - 9) / 31;
    const peakT = 0.65;
    const halfW = t <= peakT
      ? 10 * Math.sqrt(t / peakT)
      : 10 * Math.cos((Math.PI / 2) * (t - peakT) / (1 - peakT));

    if (Math.abs(nx - CX) <= halfW) {
      if (t > 0.12 && t < 0.82 && Math.abs(nx - CX) <= halfW * 0.38) return [253, 230, 138];
      if (nx < CX - halfW * 0.3) return [170, 115, 10];
      return [211, 162, 30];
    }
  }

  return [22, 79, 56]; // background #164f38
}

function png(width, height) {
  const scale = width / 64;
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 4);
    row[0] = 0;
    for (let x = 0; x < width; x++) {
      const i = 1 + x * 4;
      const color = getColor((x + 0.5) / scale, (y + 0.5) / scale);
      if (color === null) {
        row[i] = 0; row[i + 1] = 0; row[i + 2] = 0; row[i + 3] = 0;
      } else {
        row[i] = color[0]; row[i + 1] = color[1]; row[i + 2] = color[2]; row[i + 3] = 255;
      }
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
