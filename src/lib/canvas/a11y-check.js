/**
 * Accessibility checks and spoken descriptions for board objects, computed
 * from the board graph so they cover culled objects too.
 */
import { readingOrder } from "./keyboard-nav";
import { BASIC_SHAPES } from "./shapes";

// The board is drawn on the app's darkest ink; see tailwind.config's ink-900.
export const BOARD_BACKGROUND = "#070708";
// WCAG 2.2 AA: 4.5:1 for body text, 3:1 for large text (24px, or ~18.66px bold).
const NORMAL_RATIO = 4.5;
const LARGE_RATIO = 3;
const LARGE_TEXT_PX = 24;

/** `[r, g, b, a]` (0-255, alpha 0-1) for #rgb, #rrggbb, #rrggbbaa, rgb(), rgba() and transparent; null otherwise. */
export function parseColor(value) {
  if (typeof value !== "string") return null;
  const color = value.trim().toLowerCase();
  if (color === "transparent") return [0, 0, 0, 0];
  let m = /^#([0-9a-f]{3})$/.exec(color);
  if (m) return [...m[1]].map((c) => parseInt(c + c, 16)).concat(1);
  m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/.exec(color);
  if (m) {
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, m[2] ? parseInt(m[2], 16) / 255 : 1];
  }
  m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(color);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Math.min(1, Number(m[4]))];
  return null;
}

/** `top` painted over the opaque `bottom`. */
function over(top, bottom) {
  const a = top[3];
  return [0, 1, 2].map((i) => top[i] * a + bottom[i] * (1 - a)).concat(1);
}

function luminance([r, g, b]) {
  const channel = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** The WCAG contrast ratio of two colors, each composited over the board. Null when a color cannot be read. */
export function contrastRatio(foreground, background) {
  const board = parseColor(BOARD_BACKGROUND);
  const bg = parseColor(background);
  const fg = parseColor(foreground);
  if (!bg || !fg) return null;
  const back = over(bg, board);
  const front = over(fg, back);
  const [hi, lo] = [luminance(front), luminance(back)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

const SHAPE_TYPES = new Set(["rect", "ellipse", "triangle", "diamond", "shape"]);

/** The color behind a node's text: its own fill, or the frame it sits in, or the board. */
function backgroundOf(node, nodesById) {
  const board = parseColor(BOARD_BACKGROUND);
  const frame = node.parentId ? nodesById.get(node.parentId) : null;
  const frameFill = frame ? parseColor(frame.fill) : null;
  const behind = frameFill ? over(frameFill, board) : board;
  const own = node.type === "sticky" || SHAPE_TYPES.has(node.type) ? parseColor(node.fill) : null;
  const color = own ? over(own, behind) : behind;
  return `rgb(${color.slice(0, 3).map(Math.round).join(",")})`;
}

/**
 * Every accessibility issue on the board, in reading order: text whose color
 * is too close to what is behind it, images without a description, and
 * frames without a title. Each issue names the node to jump to.
 */
export function accessibilityIssues(present) {
  const nodesById = new Map(present.nodes.map((n) => [n.id, n]));
  const issues = [];
  for (const id of readingOrder(present.nodes)) {
    const node = nodesById.get(id);
    if (node.type === "image") {
      if (!node.alt?.trim()) issues.push({ id, kind: "alt", message: "Image has no description" });
      continue;
    }
    if (node.type === "frame") {
      if (!node.name?.trim() || /^(frame( \d+)?|untitled frame)$/i.test(node.name.trim())) {
        issues.push({ id, kind: "title", message: "Frame has no title" });
      }
      continue;
    }
    const hasText = typeof node.text === "string" && node.text.trim();
    if (!hasText) continue;
    const color = node.color ?? "#000000";
    const ratio = contrastRatio(color, backgroundOf(node, nodesById));
    const needed = (node.fontSize ?? 16) >= LARGE_TEXT_PX ? LARGE_RATIO : NORMAL_RATIO;
    if (ratio !== null && ratio < needed) {
      issues.push({ id, kind: "contrast", ratio, needed, message: `Low text contrast (${ratio.toFixed(1)}:1, needs ${needed}:1)` });
    }
  }
  return issues;
}

const TYPE_NAMES = { sticky: "Sticky note", text: "Text", frame: "Frame", image: "Image" };

/** What a node is, in words: "Sticky note", "Circle", "Frame". */
export function objectKind(node) {
  if (TYPE_NAMES[node.type]) return TYPE_NAMES[node.type];
  const tool = node.type === "shape" ? `shape:${node.shape}` : node.type === "rect" && node.cornerRadius ? "rect-rounded" : node.type;
  return BASIC_SHAPES.find((s) => s.tool === tool)?.label ?? "Shape";
}

const snippet = (text, max = 80) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** A one-line spoken description of a node: kind plus its text, title or image description. */
export function describeObject(node, present) {
  const kind = objectKind(node);
  if (node.type === "frame") {
    const count = present ? present.nodes.filter((n) => n.parentId === node.id).length : 0;
    const objects = `${count} object${count === 1 ? "" : "s"}`;
    return node.name?.trim() ? `${kind}: ${snippet(node.name)}, ${objects}` : `${kind}, untitled, ${objects}`;
  }
  if (node.type === "image") return node.alt?.trim() ? `${kind}: ${snippet(node.alt)}` : `${kind}, no description`;
  return node.text?.trim() ? `${kind}: ${snippet(node.text)}` : `${kind}, empty`;
}

/** "12 objects: 5 sticky notes, 3 frames, 4 shapes; 2 connectors". */
export function boardSummary(present) {
  const counts = new Map();
  for (const node of present.nodes) {
    const kind = node.type === "sticky" ? "sticky note" : node.type === "image" ? "image" : node.type === "frame" ? "frame" : node.type === "text" ? "text box" : "shape";
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  const total = present.nodes.length;
  if (!total) return "The board is empty.";
  const parts = [...counts].map(([kind, n]) => `${n} ${kind}${n === 1 ? "" : kind.endsWith("x") ? "es" : "s"}`);
  const connectors = present.connectors.length;
  return `${total} object${total === 1 ? "" : "s"}: ${parts.join(", ")}${connectors ? `; ${connectors} connector${connectors === 1 ? "" : "s"}` : ""}.`;
}
