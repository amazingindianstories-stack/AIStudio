/**
 * Browser side of board export: turns the pure SVG/CSV writers into files.
 * Everything is drawn from board data, so objects the viewport has culled
 * are included. Images are inlined as data URLs so the file stands alone.
 */
import { boardSvg } from "./board-export-svg";
import { boardPdf } from "./board-export-pdf";
import { boardVisio } from "./board-export-visio";
import { boardTextCsv } from "./board-export-csv";

/** JPG sizes: the pixel ratio applied to board units. */
export const IMAGE_SIZES = [
  { value: "small", label: "Small", scale: 0.5 },
  { value: "medium", label: "Medium", scale: 1 },
  { value: "large", label: "Large", scale: 2 },
];

// Browsers cap canvas area; stay well inside the smallest common limit.
const MAX_CANVAS_SIDE = 8192;

export function exportFileName(boardName, ext, suffix = "") {
  const base = String(boardName || "board").replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-") || "board";
  return `${base}${suffix ? `-${suffix}` : ""}.${ext}`;
}

/** The selection scope: a single selected frame exports as that frame. */
export function exportScope(state, selection, scopeKind) {
  if (scopeKind !== "selection" || !selection?.length) return {};
  const only = selection.length === 1 ? state.nodes.find((n) => n.id === selection[0]) : null;
  return only?.type === "frame" ? { frameId: only.id } : { nodeIds: selection };
}

async function toDataUrl(src) {
  const res = await fetch(src, { credentials: "same-origin" });
  if (!res.ok) throw new Error("image fetch failed");
  const blob = await res.blob();
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** Map of image node id to data URL; images that cannot be read are left out. */
async function inlineImages(state, scope) {
  const probe = boardSvg(state, { ...scope, imageHref: () => null });
  if (!probe) return {};
  const wanted = state.nodes.filter((n) => n.type === "image" && n.src && inScope(n, scope));
  const out = {};
  await Promise.all(wanted.map(async (n) => {
    try { out[n.id] = await toDataUrl(n.src); } catch { /* drawn as a grey box */ }
  }));
  return out;
}

function inScope(node, { nodeIds, frameId }) {
  if (frameId) return node.parentId === frameId;
  if (nodeIds) return nodeIds.includes(node.id);
  return true;
}

export async function buildSvg(state, scope, options = {}) {
  const images = await inlineImages(state, scope);
  return boardSvg(state, { ...scope, ...options, imageHref: (n) => images[n.id] ?? null });
}

export function buildPdf(state, scope) {
  const bytes = boardPdf(state, { ...scope, background: "#ffffff" });
  return bytes && new Blob([bytes], { type: "application/pdf" });
}

export function buildVisio(state, scope) {
  const bytes = boardVisio(state, scope);
  return bytes && new Blob([bytes], { type: "application/vnd.ms-visio.drawing" });
}

export function buildCsv(state, scope) {
  return boardTextCsv(state, scope);
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Rasterise an SVG string to a JPG blob on a white (or given) background. */
export async function svgToJpeg(svg, scale) {
  const m = /viewBox="[^"]*? [^"]*? ([\d.]+) ([\d.]+)"/.exec(svg);
  let w = Math.ceil(Number(m?.[1] ?? 1) * scale);
  let h = Math.ceil(Number(m?.[2] ?? 1) * scale);
  const shrink = Math.min(1, MAX_CANVAS_SIDE / Math.max(w, h));
  w = Math.max(1, Math.floor(w * shrink));
  h = Math.max(1, Math.floor(h * shrink));
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("render failed"));
      el.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    return await new Promise((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("encode failed"))), "image/jpeg", 0.92));
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Open the browser print dialog for the SVG, which stays vector on paper. */
export function printSvg(svg) {
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0";
  frame.srcdoc = `<!doctype html><title>Board</title><style>@page{margin:10mm}body{margin:0}svg{max-width:100%;height:auto}</style>${svg.replace(/^<\?xml[^>]*>\s*/, "")}`;
  frame.onload = () => {
    frame.contentWindow.focus();
    frame.contentWindow.print();
    setTimeout(() => frame.remove(), 60_000);
  };
  document.body.appendChild(frame);
}

/** Selected uploaded images that have a stored original to download. */
export function downloadableImages(state, selection) {
  const wanted = new Set(selection || []);
  return state.nodes.filter((n) => n.type === "image" && n.src && wanted.has(n.id));
}

const EXT_BY_MIME = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "image/avif": "avif" };

/** File name for a downloaded original: the node's own name when it has one, else numbered. */
export function originalFileName(node, mime, index) {
  const ext = EXT_BY_MIME[mime] || "bin";
  const base = String(node.name || node.fileName || "").replace(/[^\w\- .]+/g, "").trim();
  if (base) return /\.\w{2,5}$/.test(base) ? base : `${base}.${ext}`;
  return `image-${index + 1}.${ext}`;
}

/** Downloads the original bytes of each selected image, unchanged. Returns how many saved. */
export async function downloadOriginals(state, selection) {
  const nodes = downloadableImages(state, selection);
  let saved = 0;
  for (const [i, node] of nodes.entries()) {
    const res = await fetch(node.src, { credentials: "same-origin" });
    if (!res.ok) continue;
    const blob = await res.blob();
    downloadBlob(blob, originalFileName(node, blob.type, i));
    saved += 1;
  }
  return saved;
}
