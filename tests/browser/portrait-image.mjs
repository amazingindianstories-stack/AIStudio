import { deflateSync } from 'node:zlib';

function crc32(buffer) {
  let crc = ~0;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
}

/** A valid 320x400 RGB PNG (inside the 300-6000 px portrait range); `seed` makes each one's bytes unique. */
export function portraitPng(seed = 0) {
  const width = 320, height = 400;
  const row = Buffer.alloc(1 + width * 3);
  const raw = Buffer.alloc(row.length * height);
  for (let y = 0; y < height; y += 1) {
    const offset = y * row.length;
    for (let x = 0; x < width; x += 1) {
      raw[offset + 1 + x * 3] = (40 + seed * 37 + x) % 256;
      raw[offset + 2 + x * 3] = (90 + y) % 256;
      raw[offset + 3 + x * 3] = (150 + seed * 11) % 256;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('tEXt', Buffer.from(`seed\0${seed}`)), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
