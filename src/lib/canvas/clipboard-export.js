/**
 * The selection as other apps understand it: plain text (Cmd+C) and a PNG
 * image (Cmd+Shift+C). Both are drawn from the board graph, not the DOM, so
 * objects that viewport culling has not mounted copy the same way.
 */
import { readingOrder } from "./keyboard-nav";
import {
  ERD_HEADER_HEIGHT,
  ERD_ROW_HEIGHT,
  connectorPath,
  connectorPointAt,
  connectorPoints,
  isContainerNode,
  nodeBounds,
  resolveEndpoint,
} from "./geometry";
import { calloutOutlineWithTail, customSvgImage, isCalloutKind, shapeOutline, pointsToPath, textColorOf } from "./shapes";
import { textFields } from "./find";
import { BOARD_BACKGROUND } from "./a11y-check";

/** The selected nodes plus the contents of every selected container. */
export function expandSelection(present, selection) {
  const ids = new Set(selection);
  for (const node of present.nodes) {
    if (node.parentId && ids.has(node.parentId)) ids.add(node.id);
  }
  return present.nodes.filter((n) => ids.has(n.id));
}

/** An object's visible text, the same text find searches, one field per line. */
function textOf(node) {
  return textFields(node).map(({ value }) => value).join("\n");
}

/**
 * Plain text for the selection: each object's text on its own line, in
 * reading order; a selected container (frame, swimlane, diagram) contributes
 * its own text, then its contents.
 */
export function selectionText(present, selection) {
  const selected = new Set(selection);
  const nodes = present.nodes.filter((n) => selected.has(n.id));
  const lines = [];
  const seen = new Set();
  const emit = (node) => {
    if (seen.has(node.id)) return;
    seen.add(node.id);
    const text = textOf(node).trim();
    if (text) lines.push(text);
    if (isContainerNode(node)) {
      const children = present.nodes.filter((n) => n.parentId === node.id);
      const byId = new Map(children.map((n) => [n.id, n]));
      for (const id of readingOrder(children)) emit(byId.get(id));
    }
  };
  // Containers first claim their contents, so a child selected with its container is written once, under it.
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const topLevel = nodes.filter((n) => !(n.parentId && selected.has(n.parentId)));
  for (const id of readingOrder(topLevel)) emit(byId.get(id));
  return lines.join("\n");
}

const PAD = 24;
const esc = (value) => String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** Greedy word wrap of `text` to `width` pixels with `measure(text) -> px`. */
export function wrapLines(text, width, measure) {
  const out = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/(\s+)/)) {
      const next = line + word;
      if (line && measure(next.trimEnd()) > width) {
        out.push(line.trimEnd());
        line = word.trimStart();
      } else line = next;
    }
    out.push(line.trimEnd());
  }
  return out;
}

function textBlock(node, box, measure, { align = "left", valign = "top", inset = 0 } = {}) {
  const text = typeof node.text === "string" ? node.text : "";
  if (!text.trim()) return "";
  const size = node.fontSize ?? 16;
  const lineHeight = size * 1.3;
  const width = Math.max(box.w - inset * 2, 1);
  const lines = wrapLines(text, width, (s) => measure(s, size));
  const blockHeight = lines.length * lineHeight;
  const top = valign === "middle" ? box.y + (box.h - blockHeight) / 2 : box.y + inset;
  const anchor = align === "center" ? "middle" : align === "right" ? "end" : "start";
  const x = align === "center" ? box.x + box.w / 2 : align === "right" ? box.x + box.w - inset : box.x + inset;
  const spans = lines
    .map((line, i) => `<tspan x="${x}" y="${top + size + i * lineHeight}">${esc(line) || " "}</tspan>`)
    .join("");
  return `<text font-family="Inter, system-ui, sans-serif" font-size="${size}" fill="${esc(textColorOf(node))}" text-anchor="${anchor}">${spans}</text>`;
}

/** `text` cut with an ellipsis to fit `width` pixels. */
function fitText(text, width, size, measure) {
  if (measure(text, size) <= width) return text;
  let cut = text;
  while (cut && measure(`${cut}…`, size) > width) cut = cut.slice(0, -1);
  return `${cut}…`;
}

function label(text, x, y, width, measure, { size = 12, weight = 400, fill = "#f4f4f5", anchor = "start" } = {}) {
  if (!text) return "";
  const fitted = esc(fitText(text, Math.max(width, 1), size, measure));
  return `<text x="${x}" y="${y}" font-family="Inter, system-ui, sans-serif" font-size="${size}" font-weight="${weight}" fill="${esc(fill)}" text-anchor="${anchor}">${fitted}</text>`;
}

/** Where a callout's tail points; null without a tail or when the object it points at is not drawn. */
function calloutTip(node, nodesById) {
  if (!isCalloutKind(node.shape) || !node.tail) return null;
  if ("nodeId" in node.tail && !nodesById[node.tail.nodeId]) return null;
  return resolveEndpoint(node.tail, nodesById);
}

function shapeMarkup(node, measure, nodesById) {
  const paint = `fill="${esc(node.fill ?? "#ffffff")}" stroke="${esc(node.stroke ?? "#000000")}" stroke-width="${node.strokeWidth ?? 1}"`;
  let outline;
  if (node.type === "rect") outline = `<rect x="${node.x}" y="${node.y}" width="${node.w}" height="${node.h}" rx="${node.cornerRadius ?? 0}" ${paint}/>`;
  else if (node.type === "ellipse") outline = `<ellipse cx="${node.x + node.w / 2}" cy="${node.y + node.h / 2}" rx="${node.w / 2}" ry="${node.h / 2}" ${paint}/>`;
  else if (node.shape === "custom" && node.svg) {
    // Drawn like the board draws it: a box with the shape's own markup inside.
    const href = customSvgImage(node.svg, node.svgViewBox, node.stroke ?? "#000000", node.strokeWidth ?? 1);
    outline = `<rect x="${node.x}" y="${node.y}" width="${node.w}" height="${node.h}" rx="${node.cornerRadius ?? 4}" ${paint}/>`
      + `<image href="${esc(href)}" x="${node.x + node.w * 0.08}" y="${node.y + node.h * 0.08}" width="${node.w * 0.84}" height="${node.h * 0.84}"/>`;
  } else {
    const tip = calloutTip(node, nodesById);
    let points;
    if (node.type === "triangle") points = [[node.w / 2, 0], [node.w, node.h], [0, node.h]];
    else if (node.type === "diamond") points = [[node.w / 2, 0], [node.w, node.h / 2], [node.w / 2, node.h], [0, node.h / 2]];
    else if (tip) points = calloutOutlineWithTail(node.shape, node.w, node.h, { x: tip.x - node.x, y: tip.y - node.y });
    else points = shapeOutline(node.shape, node.w, node.h);
    outline = `<path transform="translate(${node.x} ${node.y})" d="${pointsToPath(points)}" ${paint}/>`;
  }
  return outline + textBlock(node, nodeBounds(node), measure, { align: "center", valign: "middle", inset: 8 });
}

/** An ERD table: its name in the header, then a row per attribute with the cells its columns show. */
function erdMarkup(node, measure) {
  const stroke = node.stroke ?? "#6366f1";
  const color = node.color ?? "#f4f4f5";
  const columns = node.columns ?? 3;
  const rows = Array.isArray(node.rows) ? node.rows : [];
  let out = `<rect x="${node.x}" y="${node.y}" width="${node.w}" height="${node.h}" rx="6" fill="${esc(node.fill ?? "#18181b")}" stroke="${esc(stroke)}" stroke-width="${node.strokeWidth ?? 2}"/>`
    + `<rect x="${node.x}" y="${node.y}" width="${node.w}" height="${ERD_HEADER_HEIGHT}" fill="${esc(node.headerFill ?? "rgba(99, 102, 241, 0.28)")}"/>`
    + label(node.name || "Entity", node.x + 12, node.y + ERD_HEADER_HEIGHT / 2 + 4, node.w - 24, measure, { weight: 600, fill: color });
  // Cell x offsets and widths per column count, as the table lays them out: key, attribute, type.
  const right = node.w - 80;
  const layout = columns === 3
    ? [[6, 34, "#fcd34d"], [48, right - 52, color], [right + 8, 66, "#a1a1aa"]]
    : columns === 2 ? [[8, right - 12, color], [right + 8, 66, "#a1a1aa"]] : [[8, node.w - 16, color]];
  rows.forEach((row, i) => {
    const top = node.y + ERD_HEADER_HEIGHT + i * ERD_ROW_HEIGHT;
    out += `<line x1="${node.x}" y1="${top}" x2="${node.x + node.w}" y2="${top}" stroke="rgba(255,255,255,0.1)"/>`;
    (row.cells ?? []).slice(0, columns).forEach((cell, c) => {
      const [dx, width, fill] = layout[c];
      out += label(cell, node.x + dx, top + ERD_ROW_HEIGHT / 2 + 4, width, measure, { size: 11, fill });
    });
  });
  return out;
}

const POOL_HEADER = 34;
const LANE_TITLE_WIDTH = 110;
const LANE_HEADER = 36;

/** A swimlane: the pool name in its header, then each lane with its name, across or down by orientation. */
function swimlaneMarkup(node, measure) {
  const stroke = esc(node.stroke ?? "#52525b");
  const color = node.color ?? "#f4f4f5";
  const lanes = Array.isArray(node.lanes) ? node.lanes : [];
  const total = lanes.reduce((sum, lane) => sum + (lane.size || 160), 0) || 1;
  const across = node.orientation !== "vertical";
  const bodyY = node.y + POOL_HEADER;
  const bodyH = node.h - POOL_HEADER;
  let out = `<rect x="${node.x}" y="${node.y}" width="${node.w}" height="${node.h}" rx="6" fill="${esc(node.fill ?? "rgba(24, 24, 27, 0.45)")}" stroke="${stroke}" stroke-width="${node.strokeWidth ?? 2}"/>`
    + `<rect x="${node.x}" y="${node.y}" width="${node.w}" height="${POOL_HEADER}" fill="${esc(node.headerFill ?? "rgba(63, 63, 70, 0.55)")}"/>`
    + `<line x1="${node.x}" y1="${bodyY}" x2="${node.x + node.w}" y2="${bodyY}" stroke="${stroke}"/>`
    + label(node.name || "Swimlane Pool", node.x + 12, node.y + POOL_HEADER / 2 + 4, node.w - 24, measure, { weight: 600, fill: color });
  let offset = 0;
  lanes.forEach((lane, i) => {
    const share = (lane.size || 160) / total;
    const name = lane.name || `Lane ${i + 1}`;
    if (across) {
      const top = bodyY + offset * bodyH;
      const height = share * bodyH;
      if (i) out += `<line x1="${node.x}" y1="${top}" x2="${node.x + node.w}" y2="${top}" stroke="${stroke}"/>`;
      out += `<line x1="${node.x + LANE_TITLE_WIDTH}" y1="${top}" x2="${node.x + LANE_TITLE_WIDTH}" y2="${top + height}" stroke="${stroke}"/>`
        + label(name, node.x + 8, top + height / 2 + 4, LANE_TITLE_WIDTH - 16, measure, { size: 11, weight: 500, fill: color });
    } else {
      const left = node.x + offset * node.w;
      const width = share * node.w;
      if (i) out += `<line x1="${left}" y1="${bodyY}" x2="${left}" y2="${node.y + node.h}" stroke="${stroke}"/>`;
      out += `<line x1="${left}" y1="${bodyY + LANE_HEADER}" x2="${left + width}" y2="${bodyY + LANE_HEADER}" stroke="${stroke}"/>`
        + label(name, left + 8, bodyY + LANE_HEADER / 2 + 4, width - 16, measure, { size: 11, weight: 500, fill: color });
    }
    offset += share;
  });
  return out;
}

const DIAGRAM_HEADER = 30;

/** A diagram: its dashed outline and its title in the header. */
function diagramMarkup(node, measure) {
  const stroke = esc(node.stroke ?? "#6366f1");
  return `<rect x="${node.x}" y="${node.y}" width="${node.w}" height="${node.h}" rx="8" fill="${esc(node.fill ?? "rgba(15, 23, 42, 0.35)")}" stroke="${stroke}" stroke-width="${node.strokeWidth ?? 2}" stroke-dasharray="6 4"/>`
    + `<rect x="${node.x}" y="${node.y}" width="${node.w}" height="${DIAGRAM_HEADER}" fill="${esc(node.headerFill ?? "rgba(15, 23, 42, 0.75)")}"/>`
    + label("DIAGRAM", node.x + 12, node.y + DIAGRAM_HEADER / 2 + 4, 64, measure, { size: 10, weight: 600, fill: "#a5b4fc" })
    + label(node.name || "System Diagram", node.x + 80, node.y + DIAGRAM_HEADER / 2 + 4, node.w - 92, measure, { weight: 600, fill: "#ffffff" });
}

/** A connector's text labels, boxed at their place along it as the board shows them. */
/** Each label of connector `c` with where its box sits: center `pt`, rotation `rot` and width `boxW` (20 high). */
function connectorLabels(c, nodesById) {
  if (!Array.isArray(c.labels)) return [];
  return c.labels.map((item) => {
    const pt = connectorPointAt(c, nodesById, item.position ?? 0.5);
    let rot = item.orientation === "aligned" ? pt.angle : 0;
    if (rot > 90) rot -= 180;
    if (rot < -90) rot += 180;
    const text = item.text || "";
    return { text, pt, rot, boxW: Math.max(36, text.length * 6.8 + 14) };
  });
}

function connectorLabelsMarkup(c, nodesById) {
  return connectorLabels(c, nodesById).map(({ text, pt, rot, boxW }) =>
    `<g transform="translate(${pt.x} ${pt.y}) rotate(${rot})">`
      + `<rect x="${-boxW / 2}" y="-10" width="${boxW}" height="20" rx="4" fill="#18181b" stroke="rgba(255,255,255,0.25)"/>`
      + `<text x="0" y="4" text-anchor="middle" font-family="Inter, system-ui, sans-serif" font-size="11" fill="#f4f4f5">${esc(text)}</text></g>`).join("");
}

function nodeMarkup(node, measure, images, nodesById) {
  const opacity = node.opacity != null && node.opacity < 1 ? ` opacity="${node.opacity}"` : "";
  let body = "";
  switch (node.type) {
    case "frame":
      body = `<rect x="${node.x}" y="${node.y}" width="${node.w}" height="${node.h}" rx="2" fill="${esc(node.fill ?? "transparent")}" stroke="${esc(node.stroke ?? "#000000")}"/>`
        + `<text x="${node.x}" y="${node.y - 8}" font-family="Inter, system-ui, sans-serif" font-size="12" fill="rgba(255,255,255,0.7)">${esc(node.name || "Untitled frame")}</text>`;
      break;
    case "sticky":
      body = `<rect x="${node.x}" y="${node.y}" width="${node.w}" height="${node.h}" rx="4" fill="${esc(node.fill)}"/>`
        + textBlock(node, nodeBounds(node), measure, { inset: 12 });
      break;
    case "text":
      body = textBlock(node, nodeBounds(node), measure, { align: node.align });
      break;
    case "image": {
      const href = images?.get(node.id);
      body = href
        ? `<image href="${esc(href)}" x="${node.x}" y="${node.y}" width="${node.w}" height="${node.h}" preserveAspectRatio="xMidYMid slice"/>`
        : `<rect x="${node.x}" y="${node.y}" width="${node.w}" height="${node.h}" fill="rgba(255,255,255,0.08)"/>`;
      break;
    }
    case "erd":
      body = erdMarkup(node, measure);
      break;
    case "swimlane":
      body = swimlaneMarkup(node, measure);
      break;
    case "diagram":
      body = diagramMarkup(node, measure);
      break;
    default:
      body = shapeMarkup(node, measure, nodesById);
  }
  return `<g${opacity}>${body}</g>`;
}

/**
 * The selection drawn as a standalone SVG on the board's background, with
 * the size it should be rasterized at. `images` maps image node ids to data
 * URLs (an image that could not be read draws as a placeholder);
 * `measure(text, fontSize)` is the text width in pixels for wrapping.
 */
export function selectionSvg(present, selection, { measure, images, selectedConnectorIds = [] }) {
  const nodes = expandSelection(present, selection);
  if (!nodes.length) return null;
  const ids = new Set(nodes.map((n) => n.id));
  const nodesById = Object.fromEntries(present.nodes.map((n) => [n.id, n]));
  const connectorSet = new Set(selectedConnectorIds);
  const connectors = present.connectors.filter((c) =>
    connectorSet.has(c.id) || ("nodeId" in c.from && ids.has(c.from.nodeId) && "nodeId" in c.to && ids.has(c.to.nodeId)));
  // The image spans everything drawn: the objects, callout tails, connector lines and their labels.
  let [left, top, right, bottom] = [Infinity, Infinity, -Infinity, -Infinity];
  const include = (x, y, r = 0) => {
    left = Math.min(left, x - r);
    top = Math.min(top, y - r);
    right = Math.max(right, x + r);
    bottom = Math.max(bottom, y + r);
  };
  for (const n of nodes) {
    include(n.x, n.y);
    include(n.x + n.w, n.y + n.h);
    const tip = calloutTip(n, nodesById);
    if (tip) include(tip.x, tip.y);
  }
  for (const c of connectors) {
    for (const p of connectorPoints(c, nodesById)) include(p.x, p.y);
    for (const { pt, boxW } of connectorLabels(c, nodesById)) include(pt.x, pt.y, Math.hypot(boxW / 2, 10));
  }
  const frameLabel = nodes.some((n) => n.type === "frame") ? 24 : 0;
  const x0 = left - PAD;
  const y0 = top - PAD - frameLabel;
  const width = Math.ceil(right + PAD - x0);
  const height = Math.ceil(bottom + PAD - y0);
  const body = nodes.map((n) => nodeMarkup(n, measure, images, nodesById)).join("");
  const lines = connectors.map((c) => {
    const marker = c.kind === "arrow" ? ` marker-end="url(#arrow-${esc(c.id)})"` : "";
    const head = c.kind === "arrow"
      ? `<marker id="arrow-${esc(c.id)}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="${esc(c.stroke)}"/></marker>`
      : "";
    return `<defs>${head}</defs><path d="${connectorPath(c, nodesById)}" fill="none" stroke="${esc(c.stroke)}" stroke-width="${c.strokeWidth}"${marker}/>`
      + connectorLabelsMarkup(c, nodesById);
  }).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${x0} ${y0} ${width} ${height}">`
    + `<rect x="${x0}" y="${y0}" width="${width}" height="${height}" fill="${BOARD_BACKGROUND}"/>${body}${lines}</svg>`;
  return { svg, width, height };
}

/** Reads a board image as a data URL through the same-origin media stream (no storage redirect, so no CORS taint). */
async function imageDataUrl(src) {
  const url = `${src}${src.includes("?") ? "&" : "?"}inline=1&w=1280`;
  const res = await fetch(url, { credentials: "same-origin" });
  if (!res.ok) throw new Error(`image ${res.status}`);
  const blob = await res.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// Keeps the PNG within what clipboards and image apps take comfortably.
const MAX_PIXELS = 4096 * 4096;

/** The selection rendered to a PNG blob in the browser; null for an empty selection. */
export async function selectionPng(present, selection, selectedConnectorIds = []) {
  const nodes = expandSelection(present, selection);
  if (!nodes.length) return null;
  const images = new Map();
  await Promise.all(nodes.filter((n) => n.type === "image").map(async (n) => {
    try {
      images.set(n.id, await imageDataUrl(n.src));
    } catch {
      // Drawn as a placeholder.
    }
  }));
  const probe = document.createElement("canvas").getContext("2d");
  const measure = (text, size) => {
    probe.font = `${size}px Inter, system-ui, sans-serif`;
    return probe.measureText(text).width;
  };
  const drawn = selectionSvg(present, selection, { measure, images, selectedConnectorIds });
  const scale = Math.min(2, Math.sqrt(MAX_PIXELS / (drawn.width * drawn.height)));
  const url = URL.createObjectURL(new Blob([drawn.svg], { type: "image/svg+xml" }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(drawn.width * scale));
    canvas.height = Math.max(1, Math.round(drawn.height * scale));
    canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Puts plain text on the system clipboard; false when the browser refuses. */
export async function writeClipboardText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Puts the selection on the system clipboard as a PNG; false when the browser refuses or there is nothing to copy. */
export async function writeClipboardImage(present, selection, selectedConnectorIds) {
  if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) return false;
  try {
    // A promise inside the ClipboardItem keeps Safari's user-gesture permission while the PNG renders.
    const png = selectionPng(present, selection, selectedConnectorIds).then((blob) => {
      if (!blob) throw new Error("empty selection");
      return blob;
    });
    await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
    return true;
  } catch {
    return false;
  }
}
