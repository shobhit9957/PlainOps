#!/usr/bin/env node
// Generate build/icon.png (1024×1024 — macOS dmg builds require ≥512) and
// build/icon.ico (256px, PNG-in-ICO Vista+ format) without any image
// dependency: the PlainOps ">_" mark, off-white on the brand evergreen tile.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const BG = [0x1e, 0x7a, 0x4c, 255]; // evergreen tile (fern --jade)
const EDGE = [0x17, 0x66, 0x3e, 255]; // darker rim
const GLYPH = [0xf3, 0xfb, 0xf6, 255]; // --on-accent

// --- minimal PNG encoder ---
const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const ex = x1 + t * dx - px;
  const ey = y1 + t * dy - py;
  return Math.sqrt(ex * ex + ey * ey);
}

/** Render the mark at any square size; all geometry scales from a 256 grid. */
function render(SIZE) {
  const S = SIZE / 256;
  const RADIUS = 52 * S;
  const STROKE = 13 * S;
  const rim = Math.max(1, Math.round(3 * S));

  const inRoundedRect = (x, y) => {
    const r = RADIUS;
    const cx = x < r ? r : x > SIZE - 1 - r ? SIZE - 1 - r : x;
    const cy = y < r ? r : y > SIZE - 1 - r ? SIZE - 1 - r : y;
    const dx = x - cx;
    const dy = y - cy;
    return dx * dx + dy * dy <= r * r;
  };
  // The ">" chevron and the "_" underscore.
  const glyph = (x, y) => {
    if (distToSegment(x, y, 76 * S, 86 * S, 128 * S, 128 * S) <= STROKE) return true;
    if (distToSegment(x, y, 128 * S, 128 * S, 76 * S, 170 * S) <= STROKE) return true;
    if (x >= 148 * S && x <= 198 * S && y >= 158 * S && y <= 176 * S) return true;
    return false;
  };

  const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
  for (let y = 0; y < SIZE; y++) {
    raw[y * (SIZE * 4 + 1)] = 0; // filter: none
    for (let x = 0; x < SIZE; x++) {
      const o = y * (SIZE * 4 + 1) + 1 + x * 4;
      let px = [0, 0, 0, 0];
      if (inRoundedRect(x, y)) {
        const edge =
          !inRoundedRect(x - rim, y) || !inRoundedRect(x + rim, y) || !inRoundedRect(x, y - rim) || !inRoundedRect(x, y + rim);
        px = glyph(x, y) ? GLYPH : edge ? EDGE : BG;
      }
      raw[o] = px[0];
      raw[o + 1] = px[1];
      raw[o + 2] = px[2];
      raw[o + 3] = px[3];
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const png1024 = render(1024); // icon.png — electron-builder derives icns from this
const png256 = render(256); // ICO payload — 256 is the ICO format ceiling

// --- ICO container with a single embedded PNG (Vista+ format) ---
const icoHeader = Buffer.alloc(6);
icoHeader.writeUInt16LE(0, 0);
icoHeader.writeUInt16LE(1, 2); // type: icon
icoHeader.writeUInt16LE(1, 4); // one image
const entry = Buffer.alloc(16);
entry[0] = 0; // 0 = 256px
entry[1] = 0;
entry.writeUInt16LE(1, 4); // planes
entry.writeUInt16LE(32, 6); // bpp
entry.writeUInt32LE(png256.length, 8);
entry.writeUInt32LE(22, 12); // offset
const ico = Buffer.concat([icoHeader, entry, png256]);

const outDir = path.join(process.cwd(), 'build');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'icon.png'), png1024);
fs.writeFileSync(path.join(outDir, 'icon.ico'), ico);
console.log(`icon.png 1024px (${png1024.length} B) + icon.ico 256px (${ico.length} B) written to build/`);
