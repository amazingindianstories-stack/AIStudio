/**
 * Import of Visio .vsdx diagrams: the first page's shapes, text and
 * connectors become board nodes and connectors. A .vsdx file is a zip of
 * XML parts; it is only read as data (no macros, links or embedded objects
 * are touched), with caps on file size, entry count, inflated bytes and XML
 * size, and the XML reader rejects DOCTYPE and entities.
 */
import { labelText, parseXml } from "./import-drawio";

export const MAX_VSDX_BYTES = 10 * 1024 * 1024;
const MAX_ENTRIES = 2000;
const MAX_PART_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_INFLATED = 20 * 1024 * 1024;
const PX_PER_INCH = 96;

async function inflateRaw(bytes, limit) {
  if (typeof DecompressionStream === "undefined") throw new Error("Not supported here");
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
  const parts = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel();
      throw new Error("File is too large");
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

/** Central directory entries of a zip: `{ name, method, offset, size }`. */
export function zipEntries(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("Not a zip file");
  const count = view.getUint16(eocd + 10, true);
  if (count > MAX_ENTRIES) throw new Error("Too many entries");
  let at = view.getUint32(eocd + 16, true);
  const entries = [];
  for (let n = 0; n < count; n++) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== 0x02014b50) throw new Error("Malformed zip");
    const nameLen = view.getUint16(at + 28, true);
    const extraLen = view.getUint16(at + 30, true);
    const commentLen = view.getUint16(at + 32, true);
    entries.push({
      method: view.getUint16(at + 10, true),
      size: view.getUint32(at + 24, true),
      compressedSize: view.getUint32(at + 20, true),
      offset: view.getUint32(at + 42, true),
      name: new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLen)),
    });
    at += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function readEntry(bytes, entry, budget) {
  if (entry.size > MAX_PART_BYTES) throw new Error("File is too large");
  budget.left -= entry.size;
  if (budget.left < 0) throw new Error("File is too large");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (entry.offset + 30 > bytes.length || view.getUint32(entry.offset, true) !== 0x04034b50) throw new Error("Malformed zip");
  const start = entry.offset + 30 + view.getUint16(entry.offset + 26, true) + view.getUint16(entry.offset + 28, true);
  const raw = bytes.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return raw;
  if (entry.method !== 8) throw new Error("Unsupported zip");
  return inflateRaw(raw, MAX_PART_BYTES);
}

function walk(el, name, out = []) {
  for (const child of el.children) {
    if (child.name === name) out.push(child);
    walk(child, name, out);
  }
  return out;
}

function cells(shape) {
  const map = {};
  for (const c of shape.children) if (c.name === "Cell") map[c.attrs.N] = c.attrs.V;
  return map;
}

function inches(value, fallback = 0) {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n * PX_PER_INCH : fallback;
}

function visioColor(value, fallback) {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
}

/** Board objects for the shapes of one Visio page XML (a parsed PageContents). */
export function pageToBoard(page, { origin = { x: 0, y: 0 }, newId = () => crypto.randomUUID() } = {}) {
  const top = page.children.find((c) => c.name === "PageContents");
  const shapesRoot = top?.children.find((c) => c.name === "Shapes");
  if (!shapesRoot) throw new Error("Not a Visio page");
  const placed = [];
  const lines = [];
  const walkShapes = (list, base) => {
    for (const shape of list.children.filter((c) => c.name === "Shape")) {
      const c = cells(shape);
      const sub = shape.children.find((x) => x.name === "Shapes");
      if (c.BeginX !== undefined && c.EndX !== undefined) {
        lines.push({ id: shape.attrs.ID, c, base });
        continue;
      }
      const w = Math.max(inches(c.Width, 96), 4);
      const h = Math.max(inches(c.Height, 48), 4);
      const pinX = inches(c.PinX);
      const pinY = inches(c.PinY);
      const x = base.x + pinX - inches(c.LocPinX, w / 2);
      const yUp = base.y + pinY - inches(c.LocPinY, h / 2);
      const text = labelText(shape.children.find((x) => x.name === "Text")?.text ?? "");
      if (sub) walkShapes(sub, { x: base.x + pinX - inches(c.LocPinX, w / 2), y: base.y + pinY - inches(c.LocPinY, h / 2) });
      else placed.push({ id: shape.attrs.ID, x, yUp, w, h, text, c, ellipse: walk(shape, "Row").some((r) => r.attrs.T === "Ellipse") });
    }
  };
  walkShapes(shapesRoot, { x: 0, y: 0 });
  const maxY = Math.max(...placed.map((p) => p.yUp + p.h), ...lines.map((l) => Math.max(inches(l.c.BeginY), inches(l.c.EndY))), 0);
  const flip = (yUp) => maxY - yUp;
  const nodes = placed.map((p) => ({
    id: newId(), opacity: 1, parentId: null, groupId: null,
    x: p.x, y: flip(p.yUp + p.h), w: p.w, h: p.h,
    type: p.ellipse || /Ellipse/i.test(p.c.Geometry ?? "") ? "ellipse" : "rect",
    text: p.text,
    fill: visioColor(p.c.FillForegnd, "rgba(255,255,255,0.06)"),
    stroke: visioColor(p.c.LineColor, "rgba(255,255,255,0.55)"),
    strokeWidth: 2,
    color: "#ffffff",
  }));
  const idMap = new Map(placed.map((p, i) => [p.id, nodes[i].id]));
  const connects = walk(page, "Connect");
  const connectors = lines.map((l) => {
    const end = (cellName, fromCell, px, py) => {
      const link = connects.find((k) => k.attrs.FromSheet === l.id && k.attrs.FromCell === fromCell);
      const target = link && idMap.get(link.attrs.ToSheet);
      return target ? { nodeId: target, anchor: "auto" } : { x: inches(l.c[px]), y: flip(inches(l.c[py])) };
    };
    return {
      id: newId(),
      from: end("begin", "BeginX", "BeginX", "BeginY"),
      to: end("end", "EndX", "EndX", "EndY"),
      kind: "arrow", stroke: "rgba(255,255,255,0.7)", strokeWidth: 2, endCap: "arrow",
    };
  });
  // Shift so the imported diagram's top left lands at the origin.
  const minX = Math.min(...nodes.map((n) => n.x));
  const minY = Math.min(...nodes.map((n) => n.y));
  const dx = origin.x - (Number.isFinite(minX) ? minX : 0);
  const dy = origin.y - (Number.isFinite(minY) ? minY : 0);
  for (const n of nodes) { n.x += dx; n.y += dy; }
  for (const k of connectors) for (const e of ["from", "to"]) if (!("nodeId" in k[e])) k[e] = { x: k[e].x + dx, y: k[e].y + dy };
  return { nodes, connectors };
}

/** Parses the bytes of a .vsdx file into `{ nodes, connectors }` for its first page. */
export async function importVisio(buffer, options) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.length > MAX_VSDX_BYTES) throw new Error("File is too large");
  const entries = zipEntries(bytes);
  const pages = entries
    .filter((e) => /^visio\/pages\/page\d+\.xml$/.test(e.name))
    .sort((a, b) => Number(a.name.match(/\d+/)[0]) - Number(b.name.match(/\d+/)[0]));
  if (!pages.length) throw new Error("Not a Visio file");
  const data = await readEntry(bytes, pages[0], { left: MAX_TOTAL_INFLATED });
  const result = pageToBoard(parseXml(new TextDecoder().decode(data)), options);
  if (!result.nodes.length) throw new Error("Nothing to import");
  return result;
}
