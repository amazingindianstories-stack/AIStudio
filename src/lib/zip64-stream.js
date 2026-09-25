const encoder = new TextEncoder();
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let value = n;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  return value >>> 0;
});

function crc32Update(crc, bytes) {
  let value = crc;
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return value >>> 0;
}

function record(length) {
  const bytes = new Uint8Array(length);
  return { bytes, view: new DataView(bytes.buffer) };
}
function u16(view, offset, value) { view.setUint16(offset, value, true); }
function u32(view, offset, value) { view.setUint32(offset, value >>> 0, true); }
function u64(view, offset, value) { view.setBigUint64(offset, BigInt(value), true); }
function join(...parts) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0; for (const part of parts) { out.set(part, at); at += part.length; } return out;
}
function dosTime(date = new Date()) {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/** Stream a standards-compliant stored-entry Zip64 archive to `write`. */
export async function writeZip64(entries, write, { now = new Date(), onEntry } = {}) {
  let offset = 0n;
  const central = [];
  const stamp = dosTime(now);
  const emit = async (bytes) => { await write(bytes); offset += BigInt(bytes.length); };
  for await (const entry of entries) {
    const name = encoder.encode(entry.name);
    const localOffset = offset;
    const extra = record(20); u16(extra.view, 0, 0x0001); u16(extra.view, 2, 16); u64(extra.view, 4, entry.size); u64(extra.view, 12, entry.size);
    const header = record(30);
    u32(header.view, 0, 0x04034b50); u16(header.view, 4, 45); u16(header.view, 6, 0x0808); u16(header.view, 8, 0);
    u16(header.view, 10, stamp.time); u16(header.view, 12, stamp.date); u32(header.view, 18, 0xffffffff); u32(header.view, 22, 0xffffffff);
    u16(header.view, 26, name.length); u16(header.view, 28, extra.bytes.length);
    await emit(join(header.bytes, name, extra.bytes));
    let crc = 0xffffffff; let actual = 0n;
    for await (const part of entry.stream) {
      const bytes = part instanceof Uint8Array ? part : new Uint8Array(part);
      crc = crc32Update(crc, bytes); actual += BigInt(bytes.length); await emit(bytes);
    }
    if (actual !== BigInt(entry.size)) throw new Error(`source size changed for ${entry.name}`);
    crc = (crc ^ 0xffffffff) >>> 0;
    const descriptor = record(24); u32(descriptor.view, 0, 0x08074b50); u32(descriptor.view, 4, crc); u64(descriptor.view, 8, actual); u64(descriptor.view, 16, actual);
    await emit(descriptor.bytes);
    central.push({ name, size: actual, crc, offset: localOffset, stamp });
    await onEntry?.(central.length);
  }
  const centralOffset = offset;
  for (const entry of central) {
    const extra = record(28); u16(extra.view, 0, 0x0001); u16(extra.view, 2, 24); u64(extra.view, 4, entry.size); u64(extra.view, 12, entry.size); u64(extra.view, 20, entry.offset);
    const header = record(46);
    u32(header.view, 0, 0x02014b50); u16(header.view, 4, 45); u16(header.view, 6, 45); u16(header.view, 8, 0x0808);
    u16(header.view, 10, 0); u16(header.view, 12, entry.stamp.time); u16(header.view, 14, entry.stamp.date); u32(header.view, 16, entry.crc);
    u32(header.view, 20, 0xffffffff); u32(header.view, 24, 0xffffffff); u16(header.view, 28, entry.name.length); u16(header.view, 30, extra.bytes.length); u32(header.view, 38, 0); u32(header.view, 42, 0xffffffff);
    await emit(join(header.bytes, entry.name, extra.bytes));
  }
  const centralSize = offset - centralOffset;
  const zip64Offset = offset;
  const end = record(56); u32(end.view, 0, 0x06064b50); u64(end.view, 4, 44); u16(end.view, 12, 45); u16(end.view, 14, 45); u64(end.view, 24, central.length); u64(end.view, 32, central.length); u64(end.view, 40, centralSize); u64(end.view, 48, centralOffset);
  await emit(end.bytes);
  const locator = record(20); u32(locator.view, 0, 0x07064b50); u64(locator.view, 8, zip64Offset); u32(locator.view, 16, 1); await emit(locator.bytes);
  const classic = record(22); u32(classic.view, 0, 0x06054b50); u16(classic.view, 8, 0xffff); u16(classic.view, 10, 0xffff); u32(classic.view, 12, 0xffffffff); u32(classic.view, 16, 0xffffffff); await emit(classic.bytes);
  return { bytes: Number(offset), entries: central.length };
}

export function extensionFromContentType(contentType, key = "") {
  const type = String(contentType || "").split(";")[0].toLowerCase();
  if (type === "image/jpeg") return "jpg";
  if (type === "image/png") return "png";
  if (type === "image/webp") return "webp";
  if (type === "image/gif") return "gif";
  const match = key.match(/\.([a-z0-9]{2,5})$/i);
  return match?.[1]?.toLowerCase() || "bin";
}
