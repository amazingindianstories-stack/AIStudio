/**
 * Visio .vsdx export of a board, written from the board data model (never the
 * DOM). The file is a zip (stored, no compression) of the XML parts Visio
 * needs for one page: shapes with text and fill/line colours, and connectors
 * that are glued to their shapes. Images and structured objects become plain
 * boxes. The page is in inches (96 px per inch) with Y pointing up.
 */
import { exportModel, xmlEscape } from "./board-export-svg";

const PX_PER_INCH = 96;
const NS = "http://schemas.microsoft.com/office/visio/2012/main";
const REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const DOC_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

const inch = (px) => Math.round((px / PX_PER_INCH) * 10000) / 10000;
const hex6 = (value, fallback) => (typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback);

let crcTable;
export function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const b of bytes) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** A zip (stored entries) of `{ name: text }` files. */
export function zipStored(files) {
  const enc = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;
  const push = (arr) => { chunks.push(arr); offset += arr.length; };
  for (const [name, text] of Object.entries(files)) {
    const nameBytes = enc.encode(name);
    const data = enc.encode(text);
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, nameBytes.length, true);
    const head = new DataView(new ArrayBuffer(46));
    head.setUint32(0, 0x02014b50, true);
    head.setUint16(4, 20, true);
    head.setUint16(6, 20, true);
    head.setUint16(8, 0x0800, true);
    head.setUint32(16, crc, true);
    head.setUint32(20, data.length, true);
    head.setUint32(24, data.length, true);
    head.setUint16(28, nameBytes.length, true);
    head.setUint32(42, offset, true);
    central.push(new Uint8Array(head.buffer), nameBytes);
    push(new Uint8Array(local.buffer));
    push(nameBytes);
    push(data);
  }
  const cdStart = offset;
  for (const part of central) push(part);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, Object.keys(files).length, true);
  end.setUint16(10, Object.keys(files).length, true);
  end.setUint32(12, offset - cdStart, true);
  end.setUint32(16, cdStart, true);
  push(new Uint8Array(end.buffer));
  const out = new Uint8Array(offset);
  let at = 0;
  for (const part of chunks) { out.set(part, at); at += part.length; }
  return out;
}

const cell = (name, value) => `<Cell N="${name}" V="${value}"/>`;

function shapeXml(node, id, model) {
  const w = Math.max(inch(node.w), 0.01);
  const h = Math.max(inch(node.h), 0.01);
  const pinX = inch(node.x - model.x) + w / 2;
  const pinY = inch(model.h - (node.y - model.y)) - h / 2;
  const isSticky = node.type === "sticky";
  const fill = hex6(node.fill, isSticky ? "#fff59d" : "#ffffff");
  const stroke = hex6(node.stroke, "#000000");
  const text = node.type === "frame" ? node.name : node.type === "image" || node.text !== undefined ? node.text : node.name;
  const plain = String(text ?? "").replace(/<[^>]*>/g, "");
  const rotation = Number.isFinite(node.rotation) ? (-node.rotation * Math.PI) / 180 : 0;
  const geometry = node.type === "ellipse"
    ? '<Row T="Ellipse" IX="1"/>'
    : [["MoveTo", 0, 0], ["LineTo", w, 0], ["LineTo", w, h], ["LineTo", 0, h], ["LineTo", 0, 0]]
      .map(([t, x, y], i) => `<Row T="${t}" IX="${i + 1}"><Cell N="X" V="${x}"/><Cell N="Y" V="${y}"/></Row>`).join("");
  return `<Shape ID="${id}" Type="Shape">${[
    cell("PinX", pinX), cell("PinY", pinY), cell("Width", w), cell("Height", h),
    cell("LocPinX", w / 2), cell("LocPinY", h / 2), cell("Angle", rotation),
    cell("FillForegnd", fill), cell("LineColor", stroke), cell("LineWeight", 0.02),
    cell("FillPattern", node.type === "frame" ? 0 : 1),
  ].join("")}<Section N="Geometry" IX="0">${geometry}</Section>${plain ? `<Text>${xmlEscape(plain)}</Text>` : ""}</Shape>`;
}

function endPoint(end, model, ids) {
  const target = end?.nodeId && model.nodesById[end.nodeId];
  if (target && ids.has(end.nodeId)) {
    return { x: target.x + target.w / 2, y: target.y + target.h / 2, sheet: ids.get(end.nodeId) };
  }
  return { x: Number(end?.x) || 0, y: Number(end?.y) || 0, sheet: null };
}

function connectorXml(c, id, model, ids) {
  const a = endPoint(c.from, model, ids);
  const b = endPoint(c.to, model, ids);
  const pt = (p) => [inch(p.x - model.x), inch(model.h - (p.y - model.y))];
  const [ax, ay] = pt(a);
  const [bx, by] = pt(b);
  const xml = `<Shape ID="${id}" Type="Shape">${[
    cell("BeginX", ax), cell("BeginY", ay), cell("EndX", bx), cell("EndY", by),
    cell("PinX", (ax + bx) / 2), cell("PinY", (ay + by) / 2),
    cell("Width", Math.abs(bx - ax)), cell("Height", Math.abs(by - ay)),
    cell("LineColor", hex6(c.stroke, "#000000")), cell("LineWeight", 0.02),
    cell("EndArrow", (c.endCap ?? (c.kind === "arrow" ? "arrow" : "none")) === "arrow" ? 4 : 0),
  ].join("")}</Shape>`;
  const connects = [
    a.sheet ? `<Connect FromSheet="${id}" FromCell="BeginX" ToSheet="${a.sheet}" ToCell="PinX"/>` : "",
    b.sheet ? `<Connect FromSheet="${id}" FromCell="EndX" ToSheet="${b.sheet}" ToCell="PinX"/>` : "",
  ].join("");
  return { xml, connects };
}

/** The bytes of a .vsdx for `state`, or null when there is nothing to export. */
export function boardVisio(state, { nodeIds, frameId } = {}) {
  const model = exportModel(state, { nodeIds, frameId });
  if (!model) return null;
  const ids = new Map();
  let next = 1;
  const shapes = model.nodes.map((n) => { ids.set(n.id, next); return shapeXml(n, next++, model); });
  const lines = model.connectors.map((c) => connectorXml(c, next++, model, ids));
  const head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  const rels = (items) => `${head}<Relationships xmlns="${REL_NS}">${items}</Relationships>`;
  return zipStored({
    "[Content_Types].xml": `${head}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/visio/document.xml" ContentType="application/vnd.ms-visio.drawing.main+xml"/><Override PartName="/visio/pages/pages.xml" ContentType="application/vnd.ms-visio.pages+xml"/><Override PartName="/visio/pages/page1.xml" ContentType="application/vnd.ms-visio.page+xml"/></Types>`,
    "_rels/.rels": rels(`<Relationship Id="rId1" Type="${DOC_REL}/document" Target="visio/document.xml"/>`),
    "visio/document.xml": `${head}<VisioDocument xmlns="${NS}" xmlns:r="${DOC_REL}"/>`,
    "visio/_rels/document.xml.rels": rels(`<Relationship Id="rId1" Type="http://schemas.microsoft.com/visio/2010/relationships/pages" Target="pages/pages.xml"/>`),
    "visio/pages/pages.xml": `${head}<Pages xmlns="${NS}" xmlns:r="${DOC_REL}"><Page ID="0" NameU="Page-1" Name="Page-1"><PageSheet>${cell("PageWidth", inch(model.w))}${cell("PageHeight", inch(model.h))}</PageSheet><Rel r:id="rId1"/></Page></Pages>`,
    "visio/pages/_rels/pages.xml.rels": rels(`<Relationship Id="rId1" Type="http://schemas.microsoft.com/visio/2010/relationships/page" Target="page1.xml"/>`),
    "visio/pages/page1.xml": `${head}<PageContents xmlns="${NS}" xmlns:r="${DOC_REL}"><Shapes>${shapes.join("")}${lines.map((l) => l.xml).join("")}</Shapes>${lines.some((l) => l.connects) ? `<Connects>${lines.map((l) => l.connects).join("")}</Connects>` : ""}</PageContents>`,
  });
}
