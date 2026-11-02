/**
 * Import of draw.io (diagrams.net) and Lucidchart draw.io exports: the
 * mxGraph XML of an .drawio or .xml file becomes board shapes, text and
 * connectors. The file is only ever read as data: a small XML reader that
 * rejects DOCTYPE and entity declarations (so no external entities or
 * entity expansion), size and element caps, and no script or link from the
 * file reaches the board. Compressed diagrams are inflated with a byte cap.
 */
export const MAX_DRAWIO_BYTES = 5 * 1024 * 1024;
export const MAX_DRAWIO_ELEMENTS = 5000;
const MAX_INFLATED_BYTES = 10 * 1024 * 1024;
const MAX_DEPTH = 64;

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decode(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isInteger(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** A minimal XML reader: elements and attributes only. Throws on DOCTYPE/ENTITY. */
export function parseXml(source) {
  if (/<!DOCTYPE|<!ENTITY/i.test(source)) throw new Error("DOCTYPE and entities are not allowed");
  const root = { name: "#root", attrs: {}, children: [], text: "" };
  const stack = [root];
  let count = 0;
  const tag = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<\/([\w:.-]+)\s*>|<([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m;
  let last = 0;
  while ((m = tag.exec(source))) {
    if (m.index !== last) throw new Error("Malformed XML");
    last = tag.lastIndex;
    const top = stack[stack.length - 1];
    if (m[2]) {
      if (stack.length < 2 || top.name !== m[2]) throw new Error("Malformed XML");
      stack.pop();
    } else if (m[3]) {
      if (++count > MAX_DRAWIO_ELEMENTS) throw new Error("Too many elements");
      const attrs = {};
      for (const a of m[4].matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]] = decode(a[2] ?? a[3]);
      const el = { name: m[3], attrs, children: [], text: "" };
      top.children.push(el);
      if (!m[5]) {
        if (stack.length > MAX_DEPTH) throw new Error("Too deeply nested");
        stack.push(el);
      }
    } else if (m[1] !== undefined) top.text += m[1];
    else if (m[6]) top.text += decode(m[6]);
  }
  if (last !== source.length || stack.length !== 1) throw new Error("Malformed XML");
  return root;
}

function find(el, name, out = []) {
  for (const child of el.children) {
    if (child.name === name) out.push(child);
    find(child, name, out);
  }
  return out;
}

/** Inflates the base64 deflate-raw body draw.io uses for compressed diagrams. */
async function inflateDiagram(text) {
  if (typeof DecompressionStream === "undefined") throw new Error("Compressed diagrams are not supported here");
  const bytes = Uint8Array.from(atob(text.trim()), (c) => c.charCodeAt(0));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const reader = stream.getReader();
  const parts = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_INFLATED_BYTES) {
      await reader.cancel();
      throw new Error("Diagram is too large");
    }
    parts.push(value);
  }
  const merged = new Uint8Array(total);
  let at = 0;
  for (const part of parts) { merged.set(part, at); at += part.length; }
  return decodeURIComponent(new TextDecoder().decode(merged));
}

function styleMap(style = "") {
  const map = {};
  for (const part of style.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) map[part.slice(0, i)] = part.slice(i + 1);
    else if (part) map[part] = "1";
  }
  return map;
}

/** Cell labels are often HTML: keep line breaks and text, drop every tag. */
export function labelText(value = "") {
  return decode(value
    .replace(/<\s*(br|\/p|\/div|\/li)\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, ""))
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 2000);
}

function color(value, fallback) {
  return typeof value === "string" && /^#[0-9a-f]{3,8}$/i.test(value) ? value : fallback;
}

function num(value, fallback = 0) {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
}

function shapeFor(style) {
  if (style.ellipse !== undefined || /^(ellipse|umlActor|mxgraph\.flowchart\.start)/.test(style.shape ?? "")) return "ellipse";
  if (style.rhombus !== undefined || style.shape === "rhombus") return "diamond";
  if (style.triangle !== undefined || style.shape === "triangle") return "triangle";
  return "rect";
}

/**
 * Board objects for one mxGraphModel element. Child geometry is relative to
 * its parent cell, so positions are made absolute. Edges whose ends are
 * missing keep their terminal points.
 */
export function modelToBoard(model, { origin = { x: 0, y: 0 }, newId = () => crypto.randomUUID() } = {}) {
  const cells = find(model, "mxCell").map((el) => ({ el, a: el.attrs, geo: el.children.find((c) => c.name === "mxGeometry") }));
  const byId = new Map(cells.map((c) => [c.a.id, c]));
  const abs = (c, depth = 0) => {
    const parent = depth < 32 ? byId.get(c.a.parent) : null;
    const base = parent?.a.vertex === "1" ? abs(parent, depth + 1) : { x: 0, y: 0 };
    return { x: base.x + num(c.geo?.attrs.x), y: base.y + num(c.geo?.attrs.y) };
  };
  const ids = new Map();
  const nodes = [];
  const rawNodes = [];
  for (const c of cells) {
    if (c.a.vertex !== "1" || !c.geo) continue;
    const style = styleMap(c.a.style);
    const { x, y } = abs(c);
    const w = Math.max(num(c.geo.attrs.width, 120), 4);
    const h = Math.max(num(c.geo.attrs.height, 60), 4);
    const text = labelText(c.a.value);
    const id = newId();
    ids.set(c.a.id, id);
    const common = { id, opacity: 1, parentId: null, groupId: null, x, y, w, h };
    if (style.text !== undefined && style.fillColor === undefined || /^text/.test(c.a.style ?? "") && style.fillColor === undefined) {
      nodes.push({ ...common, type: "text", text, fontSize: num(style.fontSize, 16), align: ["left", "center", "right"].includes(style.align) ? style.align : "left", color: color(style.fontColor, "#ffffff") });
    } else {
      nodes.push({
        ...common,
        type: shapeFor(style),
        text,
        fill: style.fillColor === "none" ? "transparent" : color(style.fillColor, "rgba(255,255,255,0.06)"),
        stroke: style.strokeColor === "none" ? "transparent" : color(style.strokeColor, "rgba(255,255,255,0.55)"),
        strokeWidth: Math.max(num(style.strokeWidth, 2), 1),
        color: color(style.fontColor, "#ffffff"),
        ...(style.rounded === "1" ? { cornerRadius: 16 } : {}),
        ...(style.dashed === "1" ? { strokeStyle: "dashed" } : {}),
      });
    }
    rawNodes.push(nodes[nodes.length - 1]);
  }
  const connectors = [];
  for (const c of cells) {
    if (c.a.edge !== "1") continue;
    const style = styleMap(c.a.style);
    const points = (kind) => c.geo?.children.find((p) => p.name === "mxPoint" && p.attrs.as === kind)?.attrs;
    const end = (ref, kind) => {
      if (ids.has(ref)) return { nodeId: ids.get(ref), anchor: "auto" };
      const p = points(kind);
      return p ? { x: num(p.x), y: num(p.y) } : null;
    };
    const from = end(c.a.source, "sourcePoint");
    const to = end(c.a.target, "targetPoint");
    if (!from || !to) continue;
    const arrow = style.endArrow !== "none";
    connectors.push({
      id: newId(), from, to, kind: arrow ? "arrow" : "line",
      stroke: color(style.strokeColor, "rgba(255,255,255,0.7)"),
      strokeWidth: Math.max(num(style.strokeWidth, 2), 1),
      ...(style.edgeStyle?.startsWith("orthogonal") ? { shape: "elbow" } : {}),
      ...(style.dashed === "1" ? { strokeStyle: "dashed" } : {}),
      ...(arrow ? { endCap: "arrow" } : {}),
      ...(style.startArrow && style.startArrow !== "none" ? { startCap: "arrow" } : {}),
    });
  }
  // Shift so the imported diagram's top left lands at the origin.
  const minX = Math.min(...rawNodes.map((n) => n.x));
  const minY = Math.min(...rawNodes.map((n) => n.y));
  const dx = origin.x - (Number.isFinite(minX) ? minX : 0);
  const dy = origin.y - (Number.isFinite(minY) ? minY : 0);
  for (const n of nodes) { n.x += dx; n.y += dy; }
  for (const c of connectors) for (const k of ["from", "to"]) if (!("nodeId" in c[k])) { c[k] = { x: c[k].x + dx, y: c[k].y + dy }; }
  return { nodes, connectors };
}

/** Parses the text of a .drawio or .xml file into `{ nodes, connectors }` for its first page. */
export async function importDrawio(source, options) {
  if (typeof source !== "string" || source.length > MAX_DRAWIO_BYTES) throw new Error("File is too large");
  const doc = parseXml(source);
  let model = find(doc, "mxGraphModel")[0];
  if (!model) {
    const diagram = find(doc, "diagram")[0];
    const body = diagram?.text.trim();
    if (!body) throw new Error("Not a draw.io file");
    model = find(parseXml(await inflateDiagram(body)), "mxGraphModel")[0];
    if (!model) throw new Error("Not a draw.io file");
  }
  const result = modelToBoard(model, options);
  if (!result.nodes.length) throw new Error("Nothing to import");
  return result;
}
