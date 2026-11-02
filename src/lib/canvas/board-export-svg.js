/**
 * Vector export of a board: an SVG document written from the board data
 * model (never the DOM), so objects the viewport has culled are included.
 * `nodeIds` limits the export to a selection, `frameId` to the objects a
 * frame holds (the frame is drawn too). Connectors are kept when both ends
 * are free points or exported nodes.
 */
import { connectorPath, nodeBounds, nodeRotation, unionBounds } from "./geometry";
import { pointsToPath, shapeOutline } from "./shapes";

export const EXPORT_PADDING = 24;

export function xmlEscape(text) {
  return String(text ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/** Only plain colors reach the file; anything else (urls, scripts) falls back. */
export function paint(value, fallback) {
  return typeof value === "string" && /^(#[0-9a-f]{3,8}|[a-z]{3,20}|rgba?\([\d\s.,%]+\))$/i.test(value) ? value : fallback;
}

function num(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

/** The nodes an export covers, in board order. */
export function exportNodes(state, { nodeIds = null, frameId = null } = {}) {
  const nodes = state.nodes ?? [];
  if (frameId) return nodes.filter((n) => n.id === frameId || n.parentId === frameId);
  if (nodeIds) {
    const wanted = new Set(nodeIds);
    return nodes.filter((n) => wanted.has(n.id));
  }
  return nodes;
}

function wrapLine(line, maxChars) {
  const words = line.split(/\s+/).filter(Boolean);
  const out = [];
  let cur = "";
  for (const word of words) {
    if (cur && cur.length + word.length + 1 > maxChars) {
      out.push(cur);
      cur = word;
    } else {
      cur = cur ? `${cur} ${word}` : word;
    }
  }
  out.push(cur);
  return out;
}

function textBlock(node, { x, y, w, h, anchor = "middle", vAlign = "middle", pad = 8 }) {
  const raw = typeof node.text === "string" ? node.text : "";
  if (!raw) return "";
  const size = num(node.fontSize, 16);
  const maxChars = Math.max(1, Math.floor((w - pad * 2) / (size * 0.55)));
  const lines = raw.split("\n").flatMap((line) => wrapLine(line, maxChars));
  const lineH = size * 1.25;
  const total = lines.length * lineH;
  const top = vAlign === "top" ? y + pad : y + (h - total) / 2;
  const tx = anchor === "start" ? x + pad : anchor === "end" ? x + w - pad : x + w / 2;
  const spans = lines
    .map((line, i) => `<tspan x="${tx}" y="${top + lineH * i + size}">${xmlEscape(line)}</tspan>`)
    .join("");
  const family = typeof node.font === "string" && /^[\w\s,'-]{1,80}$/.test(node.font) ? node.font : "sans-serif";
  return `<text font-family="${xmlEscape(family)}" font-size="${size}" fill="${paint(node.color, "#000000")}" text-anchor="${anchor}">${spans}</text>`;
}

const ANCHOR_OF_ALIGN = { left: "start", center: "middle", right: "end" };

function dashFor(node) {
  const w = Math.max(num(node.strokeWidth, 1), 1);
  if (node.strokeStyle === "dashed") return ` stroke-dasharray="${w * 4} ${w * 3}"`;
  if (node.strokeStyle === "dotted") return ` stroke-dasharray="${w} ${w * 2}"`;
  return "";
}

function nodeSvg(node, imageHref) {
  const { x, y, w, h } = node;
  const fill = paint(node.fill, "none");
  const stroke = paint(node.stroke, "none");
  const sw = num(node.strokeWidth, 1);
  const look = `fill="${fill}" stroke="${stroke}" stroke-width="${sw}"${dashFor(node)}`;
  let body = "";
  switch (node.type) {
    case "rect":
      body = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${num(node.cornerRadius, 0)}" ${look}/>`
        + textBlock(node, { x, y, w, h, anchor: ANCHOR_OF_ALIGN[node.align] ?? "middle" });
      break;
    case "ellipse":
      body = `<ellipse cx="${x + w / 2}" cy="${y + h / 2}" rx="${w / 2}" ry="${h / 2}" ${look}/>` + textBlock(node, { x, y, w, h });
      break;
    case "triangle":
    case "diamond":
    case "shape": {
      const kind = node.type === "shape" ? node.shape : node.type;
      const points = shapeOutline(kind, w, h).map(([px, py]) => [x + px, y + py]);
      body = `<path d="${pointsToPath(points)}" ${look}/>` + textBlock(node, { x, y, w, h, anchor: ANCHOR_OF_ALIGN[node.align] ?? "middle" });
      break;
    }
    case "sticky":
      body = `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${paint(node.fill, "#fff59d")}"/>`
        + textBlock(node, { x, y, w, h, anchor: "start", vAlign: "top", pad: 12 });
      break;
    case "text":
      body = textBlock(node, { x, y, w, h, anchor: ANCHOR_OF_ALIGN[node.align] ?? "start", vAlign: "top", pad: 0 });
      break;
    case "frame":
      body = `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${paint(node.fill, "none")}" stroke="${paint(node.stroke, "#000000")}" stroke-width="1"/>`
        + `<text x="${x}" y="${y - 6}" font-family="sans-serif" font-size="14" fill="#555555">${xmlEscape(node.name ?? "")}</text>`;
      break;
    case "image": {
      const href = imageHref?.(node);
      body = href
        ? `<image x="${x}" y="${y}" width="${w}" height="${h}" href="${xmlEscape(href)}" preserveAspectRatio="xMidYMid slice"/>`
        : `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#e5e7eb"/>`;
      break;
    }
    default:
      // Structured objects (tables, diagrams, swimlanes) are drawn as their box with a name.
      body = `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${paint(node.fill, "#f4f4f5")}" stroke="${paint(node.stroke, "#71717a")}" stroke-width="1"/>`
        + (node.name ? textBlock({ ...node, text: node.name }, { x, y, w, h }) : "");
  }
  const deg = nodeRotation(node);
  const opacity = Number.isFinite(node.opacity) && node.opacity < 1 ? ` opacity="${node.opacity}"` : "";
  const rotate = deg ? ` transform="rotate(${deg} ${x + w / 2} ${y + h / 2})"` : "";
  return `<g${rotate}${opacity}>${body}</g>`;
}

function connectorSvg(c, nodesById) {
  const d = connectorPath(c, nodesById);
  const dash = c.strokeStyle === "dashed" ? ' stroke-dasharray="8 6"' : c.strokeStyle === "dotted" ? ' stroke-dasharray="2 5"' : "";
  const arrow = (c.endCap ?? (c.kind === "arrow" ? "arrow" : "none")) === "arrow" ? ' marker-end="url(#export-arrowhead)"' : "";
  return `<path d="${d}" fill="none" stroke="${paint(c.stroke, "#000000")}" stroke-width="${num(c.strokeWidth, 2)}"${dash}${arrow}/>`;
}

/**
 * The SVG document for `state` ({nodes, connectors}), or null when there is
 * nothing to export. `imageHref(node)` supplies each image's href (a data
 * URL when the file must be self-contained).
 */
/** The nodes, connectors and padded bounds an export covers, or null when empty. */
export function exportModel(state, { nodeIds, frameId } = {}) {
  const nodes = exportNodes(state, { nodeIds, frameId });
  if (!nodes.length) return null;
  const nodesById = Object.fromEntries((state.nodes ?? []).map((n) => [n.id, n]));
  const inScope = new Set(nodes.map((n) => n.id));
  const connectors = (state.connectors ?? []).filter((c) =>
    [c.from, c.to].every((end) => !end?.nodeId || inScope.has(end.nodeId)) && (nodeIds || frameId ? [c.from, c.to].some((e) => e?.nodeId) : true));
  const box = unionBounds(nodes.map(nodeBounds));
  const pad = EXPORT_PADDING;
  return { nodes, connectors, nodesById, x: box.x - pad, y: box.y - pad, w: box.w + pad * 2, h: box.h + pad * 2 };
}

export function boardSvg(state, { nodeIds, frameId, imageHref, background = null, scale = 1 } = {}) {
  const model = exportModel(state, { nodeIds, frameId });
  if (!model) return null;
  const { nodes, connectors, nodesById, x, y, w, h } = model;
  const bg = background ? `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${paint(background, "#ffffff")}"/>` : "";
  return `<?xml version="1.0" encoding="UTF-8"?>\n`
    + `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(w * scale)}" height="${Math.ceil(h * scale)}" viewBox="${x} ${y} ${w} ${h}">`
    + `<defs><marker id="export-arrowhead" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="context-stroke"/></marker></defs>`
    + bg
    + nodes.map((n) => nodeSvg(n, imageHref)).join("")
    + connectors.map((c) => connectorSvg(c, nodesById)).join("")
    + `</svg>\n`;
}
