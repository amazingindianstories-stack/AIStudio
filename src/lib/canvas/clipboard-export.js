/**
 * The selection as other apps understand it: plain text (Cmd+C) and a PNG
 * image (Cmd+Shift+C). Both are drawn from the board graph, not the DOM, so
 * objects that viewport culling has not mounted copy the same way.
 */
import { readingOrder } from "./keyboard-nav";
import { connectorPath, nodeBounds } from "./geometry";
import { shapeOutline, pointsToPath, textColorOf } from "./shapes";
import { BOARD_BACKGROUND } from "./a11y-check";

/** The selected nodes plus the contents of every selected frame. */
export function expandSelection(present, selection) {
  const ids = new Set(selection);
  for (const node of present.nodes) {
    if (node.parentId && ids.has(node.parentId)) ids.add(node.id);
  }
  return present.nodes.filter((n) => ids.has(n.id));
}

function textOf(node) {
  if (node.type === "frame") return node.name ?? "";
  if (node.type === "image") return node.alt ?? "";
  return typeof node.text === "string" ? node.text : "";
}

/**
 * Plain text for the selection: each object's text on its own line, in
 * reading order; a selected frame contributes its title, then its contents.
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
    if (node.type === "frame") {
      const children = present.nodes.filter((n) => n.parentId === node.id);
      const byId = new Map(children.map((n) => [n.id, n]));
      for (const id of readingOrder(children)) emit(byId.get(id));
    }
  };
  // Frames first claim their contents, so a child selected with its frame is written once, under it.
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

function shapeMarkup(node, measure) {
  const paint = `fill="${esc(node.fill ?? "#ffffff")}" stroke="${esc(node.stroke ?? "#000000")}" stroke-width="${node.strokeWidth ?? 1}"`;
  let outline;
  if (node.type === "rect") outline = `<rect x="${node.x}" y="${node.y}" width="${node.w}" height="${node.h}" rx="${node.cornerRadius ?? 0}" ${paint}/>`;
  else if (node.type === "ellipse") outline = `<ellipse cx="${node.x + node.w / 2}" cy="${node.y + node.h / 2}" rx="${node.w / 2}" ry="${node.h / 2}" ${paint}/>`;
  else {
    const points = node.type === "triangle"
      ? [[node.w / 2, 0], [node.w, node.h], [0, node.h]]
      : node.type === "diamond"
      ? [[node.w / 2, 0], [node.w, node.h / 2], [node.w / 2, node.h], [0, node.h / 2]]
      : shapeOutline(node.shape, node.w, node.h);
    outline = `<path transform="translate(${node.x} ${node.y})" d="${pointsToPath(points)}" ${paint}/>`;
  }
  return outline + textBlock(node, nodeBounds(node), measure, { align: "center", valign: "middle", inset: 8 });
}

function nodeMarkup(node, measure, images) {
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
    default:
      body = shapeMarkup(node, measure);
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
  const frameLabel = nodes.some((n) => n.type === "frame") ? 24 : 0;
  const x0 = Math.min(...nodes.map((n) => n.x)) - PAD;
  const y0 = Math.min(...nodes.map((n) => n.y)) - PAD - frameLabel;
  const x1 = Math.max(...nodes.map((n) => n.x + n.w)) + PAD;
  const y1 = Math.max(...nodes.map((n) => n.y + n.h)) + PAD;
  const width = Math.ceil(x1 - x0);
  const height = Math.ceil(y1 - y0);
  const body = nodes.map((n) => nodeMarkup(n, measure, images)).join("");
  const lines = connectors.map((c) => {
    const marker = c.kind === "arrow" ? ` marker-end="url(#arrow-${esc(c.id)})"` : "";
    const head = c.kind === "arrow"
      ? `<marker id="arrow-${esc(c.id)}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="${esc(c.stroke)}"/></marker>`
      : "";
    return `<defs>${head}</defs><path d="${connectorPath(c, nodesById)}" fill="none" stroke="${esc(c.stroke)}" stroke-width="${c.strokeWidth}"${marker}/>`;
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
