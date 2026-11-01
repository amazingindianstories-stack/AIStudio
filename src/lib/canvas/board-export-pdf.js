/**
 * Vector PDF export of a board, written from the board data model (never the
 * DOM) with a small self-contained PDF writer: one page, shapes and
 * connectors as vector paths, text in Helvetica. Images are drawn as grey
 * boxes (their bytes are not embedded). Characters outside Latin-1 become "?".
 */
import { connectorPath, nodeRotation } from "./geometry";
import { exportModel, paint } from "./board-export-svg";
import { shapeOutline } from "./shapes";

const NAMED = {
  black: "#000000", white: "#ffffff", red: "#ff0000", green: "#008000", blue: "#0000ff", gray: "#808080",
  grey: "#808080", yellow: "#ffff00", orange: "#ffa500", purple: "#800080", pink: "#ffc0cb",
};

/** "#rgb", "#rrggbb", rgb()/rgba() or a basic name as [r, g, b] in 0..1, else null (none). */
export function parseColor(value) {
  if (typeof value !== "string") return null;
  let v = value.trim().toLowerCase();
  if (NAMED[v]) v = NAMED[v];
  let m = /^#([0-9a-f]{3,8})$/.exec(v);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join("");
    if (h.length === 8 && parseInt(h.slice(6), 16) === 0) return null;
    if (h.length !== 6 && h.length !== 8) return null;
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  }
  m = /^rgba?\(([^)]*)\)$/.exec(v);
  if (m) {
    const p = m[1].split(",").map((s) => parseFloat(s));
    if (p.length === 4 && p[3] === 0) return null;
    if (p.length >= 3 && p.slice(0, 3).every(Number.isFinite)) return p.slice(0, 3).map((n) => Math.min(Math.max(n, 0), 255) / 255);
  }
  return null;
}

const n2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : 0);
const rgb = (c) => c.map((x) => n2(x)).join(" ");
const KAPPA = 0.5522847498;

function pdfString(text) {
  let out = "";
  for (const ch of String(text ?? "")) {
    const code = ch.codePointAt(0);
    const c = code >= 32 && code < 256 ? ch : "?";
    out += c === "(" || c === ")" || c === "\\" ? `\\${c}` : c;
  }
  return out;
}

function rectPath(x, y, w, h) {
  return `${n2(x)} ${n2(y)} ${n2(w)} ${n2(h)} re`;
}

function ellipsePath(cx, cy, rx, ry) {
  const kx = rx * KAPPA;
  const ky = ry * KAPPA;
  return [
    `${n2(cx + rx)} ${n2(cy)} m`,
    `${n2(cx + rx)} ${n2(cy + ky)} ${n2(cx + kx)} ${n2(cy + ry)} ${n2(cx)} ${n2(cy + ry)} c`,
    `${n2(cx - kx)} ${n2(cy + ry)} ${n2(cx - rx)} ${n2(cy + ky)} ${n2(cx - rx)} ${n2(cy)} c`,
    `${n2(cx - rx)} ${n2(cy - ky)} ${n2(cx - kx)} ${n2(cy - ry)} ${n2(cx)} ${n2(cy - ry)} c`,
    `${n2(cx + kx)} ${n2(cy - ry)} ${n2(cx + rx)} ${n2(cy - ky)} ${n2(cx + rx)} ${n2(cy)} c h`,
  ].join("\n");
}

function polygonPath(points) {
  return points.map(([px, py], i) => `${n2(px)} ${n2(py)} ${i ? "l" : "m"}`).join("\n") + "\nh";
}

/** Parses the absolute M/L/Q/C/Z paths the board writes into PDF operators and the end tangent. */
export function svgPathToPdf(d) {
  const tokens = String(d).match(/[MLQCZ]|-?\d*\.?\d+(?:e-?\d+)?/gi) ?? [];
  const ops = [];
  let i = 0;
  let cmd = "";
  let cur = [0, 0];
  let prev = [0, 0];
  const num = () => parseFloat(tokens[i++]);
  while (i < tokens.length) {
    if (/^[MLQCZ]$/i.test(tokens[i])) cmd = tokens[i++].toUpperCase();
    if (cmd === "Z") { ops.push("h"); continue; }
    const count = { M: 1, L: 1, Q: 2, C: 3 }[cmd];
    if (!count) break;
    const pts = Array.from({ length: count }, () => [num(), num()]);
    if (pts.flat().some((v) => !Number.isFinite(v))) break;
    const end = pts[count - 1];
    if (cmd === "M") { ops.push(`${n2(end[0])} ${n2(end[1])} m`); cmd = "L"; prev = cur; }
    else if (cmd === "L") { ops.push(`${n2(end[0])} ${n2(end[1])} l`); prev = cur; }
    else if (cmd === "Q") {
      const [c1, e] = pts;
      const a = [cur[0] + (2 / 3) * (c1[0] - cur[0]), cur[1] + (2 / 3) * (c1[1] - cur[1])];
      const b = [e[0] + (2 / 3) * (c1[0] - e[0]), e[1] + (2 / 3) * (c1[1] - e[1])];
      ops.push(`${n2(a[0])} ${n2(a[1])} ${n2(b[0])} ${n2(b[1])} ${n2(e[0])} ${n2(e[1])} c`);
      prev = c1;
    } else {
      ops.push(`${pts.map((p) => `${n2(p[0])} ${n2(p[1])}`).join(" ")} c`);
      prev = pts[1];
    }
    cur = end;
  }
  return { ops: ops.join("\n"), end: cur, prev };
}

function dashOps(style, width) {
  const w = Math.max(width, 1);
  if (style === "dashed") return `[${n2(w * 4)} ${n2(w * 3)}] 0 d`;
  if (style === "dotted") return `[${n2(w)} ${n2(w * 2)}] 0 d`;
  return "[] 0 d";
}

function paintOps(path, { fill, stroke, width, style }) {
  const f = parseColor(fill);
  const s = parseColor(stroke);
  if (!f && !s) return "";
  const head = `q\n${f ? `${rgb(f)} rg\n` : ""}${s ? `${rgb(s)} RG\n${n2(width)} w\n${dashOps(style, width)}\n` : ""}`;
  return `${head}${path}\n${f && s ? "B" : f ? "f" : "S"}\nQ\n`;
}

function wrapText(text, size, maxWidth) {
  const maxChars = Math.max(1, Math.floor(maxWidth / (size * 0.55)));
  return String(text).split("\n").flatMap((line) => {
    const out = [];
    let cur = "";
    for (const word of line.split(/\s+/).filter(Boolean)) {
      if (cur && cur.length + word.length + 1 > maxChars) { out.push(cur); cur = word; }
      else cur = cur ? `${cur} ${word}` : word;
    }
    out.push(cur);
    return out;
  });
}

const ALIGN = { left: "start", center: "middle", right: "end" };

function textOps(node, { x, y, w, h, anchor = "middle", vAlign = "middle", pad = 8 }) {
  const raw = typeof node.text === "string" ? node.text : "";
  if (!raw) return "";
  const size = Number.isFinite(node.fontSize) ? node.fontSize : 16;
  const lines = wrapText(raw, size, w - pad * 2);
  const lineH = size * 1.25;
  const top = vAlign === "top" ? y + pad : y + (h - lines.length * lineH) / 2;
  const color = parseColor(paint(node.color, "#000000")) ?? [0, 0, 0];
  let out = `q\n${rgb(color)} rg\nBT\n/F1 ${n2(size)} Tf\n`;
  lines.forEach((line, i) => {
    const width = line.length * size * 0.5;
    const lx = anchor === "start" ? x + pad : anchor === "end" ? x + w - pad - width : x + (w - width) / 2;
    // The page is flipped to y-down, so the text matrix flips glyphs back upright.
    out += `1 0 0 -1 ${n2(lx)} ${n2(top + lineH * i + size)} Tm\n(${pdfString(line)}) Tj\n`;
  });
  return `${out}ET\nQ\n`;
}

function nodeOps(node) {
  const { x, y, w, h } = node;
  const look = { fill: paint(node.fill, "none"), stroke: paint(node.stroke, "none"), width: Number.isFinite(node.strokeWidth) ? node.strokeWidth : 1, style: node.strokeStyle };
  const align = ALIGN[node.align] ?? "middle";
  let body = "";
  switch (node.type) {
    case "rect": body = paintOps(rectPath(x, y, w, h), look) + textOps(node, { x, y, w, h, anchor: align }); break;
    case "ellipse": body = paintOps(ellipsePath(x + w / 2, y + h / 2, w / 2, h / 2), look) + textOps(node, { x, y, w, h }); break;
    case "triangle":
    case "diamond":
    case "shape": {
      const kind = node.type === "shape" ? node.shape : node.type;
      const pts = shapeOutline(kind, w, h).map(([px, py]) => [x + px, y + py]);
      body = paintOps(polygonPath(pts), look) + textOps(node, { x, y, w, h, anchor: align });
      break;
    }
    case "sticky":
      body = paintOps(rectPath(x, y, w, h), { fill: paint(node.fill, "#fff59d"), stroke: "none", width: 0 })
        + textOps(node, { x, y, w, h, anchor: "start", vAlign: "top", pad: 12 });
      break;
    case "text": body = textOps(node, { x, y, w, h, anchor: ALIGN[node.align] ?? "start", vAlign: "top", pad: 0 }); break;
    case "frame":
      body = paintOps(rectPath(x, y, w, h), { fill: paint(node.fill, "none"), stroke: paint(node.stroke, "#000000"), width: 1 })
        + textOps({ text: node.name ?? "", fontSize: 14, color: "#555555" }, { x, y: y - 20, w: Math.max(w, 200), h: 20, anchor: "start", vAlign: "top", pad: 0 });
      break;
    case "image": body = paintOps(rectPath(x, y, w, h), { fill: "#e5e7eb", stroke: "none", width: 0 }); break;
    default:
      body = paintOps(rectPath(x, y, w, h), { fill: paint(node.fill, "#f4f4f5"), stroke: paint(node.stroke, "#71717a"), width: 1 })
        + (node.name ? textOps({ ...node, text: node.name }, { x, y, w, h }) : "");
  }
  const deg = nodeRotation(node);
  if (!deg) return body;
  const r = (deg * Math.PI) / 180;
  const [c, s] = [Math.cos(r), Math.sin(r)];
  const cx = x + w / 2;
  const cy = y + h / 2;
  return `q\n${n2(c)} ${n2(s)} ${n2(-s)} ${n2(c)} ${n2(cx - c * cx + s * cy)} ${n2(cy - s * cx - c * cy)} cm\n${body}Q\n`;
}

function connectorOps(c, nodesById) {
  const { ops, end, prev } = svgPathToPdf(connectorPath(c, nodesById));
  if (!ops) return "";
  const width = Number.isFinite(c.strokeWidth) ? c.strokeWidth : 2;
  const color = paint(c.stroke, "#000000");
  let out = paintOps(ops, { fill: "none", stroke: color, width, style: c.strokeStyle });
  if ((c.endCap ?? (c.kind === "arrow" ? "arrow" : "none")) === "arrow") {
    const ang = Math.atan2(end[1] - prev[1], end[0] - prev[0]);
    const size = Math.max(width * 4, 10);
    const pt = (a, d) => [end[0] - Math.cos(ang + a) * d, end[1] - Math.sin(ang + a) * d];
    out += paintOps(polygonPath([end, pt(0.45, size), pt(-0.45, size)]), { fill: color, stroke: "none", width: 0 });
  }
  return out;
}

/**
 * A PDF file (Uint8Array) of `state`, or null when there is nothing to
 * export.
 */
export function boardPdf(state, { nodeIds, frameId, background = "#ffffff" } = {}) {
  const model = exportModel(state, { nodeIds, frameId });
  if (!model) return null;
  const { nodes, connectors, nodesById, x, y, w, h } = model;
  const page = [Math.ceil(w), Math.ceil(h)];
  const bg = parseColor(background);
  const content = `1 0 0 -1 ${n2(-x)} ${n2(y + page[1])} cm\n`
    + (bg ? paintOps(rectPath(x, y, page[0], page[1]), { fill: background, stroke: "none", width: 0 }) : "")
    + nodes.map(nodeOps).join("")
    + connectors.map((c) => connectorOps(c, nodesById)).join("");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${page[0]} ${page[1]}] /Contents 5 0 R /Resources << /Font << /F1 4 0 R >> >> >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    `<< /Length ${content.length} >>\nstream\n${content}endstream`,
  ];
  let file = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(file.length);
    file += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = file.length;
  file += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
    + offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")
    + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const bytes = new Uint8Array(file.length);
  for (let k = 0; k < file.length; k++) bytes[k] = file.charCodeAt(k) & 0xff;
  return bytes;
}
