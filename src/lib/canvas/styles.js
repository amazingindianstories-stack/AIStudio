/**
 * Object styles: the shared color palette, a person's saved custom colors
 * and last used style per kind of object (both personal, so kept in this
 * browser per user), copying one object's style onto others, and switching
 * an object's type.
 */
import { isShapeNode } from "./shapes";
import { DEFAULT_STICKY_COLOR, STICKY_COLORS, STICKY_SIDE } from "./stickies";

/** The 23 colors offered for shapes, lines, frames and text. */
export const BOARD_COLORS = [
  { value: "transparent", name: "Transparent" },
  { value: "#ffffff", name: "White" },
  { value: "#e5e7eb", name: "Light grey" },
  { value: "#9ca3af", name: "Grey" },
  { value: "#4b5563", name: "Dark grey" },
  { value: "#1c1a12", name: "Ink" },
  { value: "#fef08a", name: "Light yellow" },
  { value: "#e3c56a", name: "Yellow" },
  { value: "#d99a5b", name: "Orange" },
  { value: "#f97316", name: "Bright orange" },
  { value: "#c97a72", name: "Red" },
  { value: "#ef4444", name: "Bright red" },
  { value: "#d189a7", name: "Pink" },
  { value: "#ec4899", name: "Magenta" },
  { value: "#9b86c9", name: "Purple" },
  { value: "#8b5cf6", name: "Violet" },
  { value: "#6f9bd1", name: "Blue" },
  { value: "#3b82f6", name: "Bright blue" },
  { value: "#93c5fd", name: "Light blue" },
  { value: "#5fb3a8", name: "Teal" },
  { value: "#7fae86", name: "Green" },
  { value: "#22c55e", name: "Bright green" },
  { value: "#bef264", name: "Lime" },
];
export const MAX_CUSTOM_COLORS = 16;
const HEX = /^#[0-9a-f]{6}$/;

/** `#rgb` or `#rrggbb` (with or without the #) as lowercase `#rrggbb`, else null. */
export function normalizeHex(value) {
  const raw = String(value ?? "").trim().toLowerCase().replace(/^#?/, "#");
  const full = /^#[0-9a-f]{3}$/.test(raw) ? `#${[...raw.slice(1)].map((c) => c + c).join("")}` : raw;
  return HEX.test(full) ? full : null;
}

function storageKey(kind, userId) {
  return `veevee:board-${kind}:${userId ?? "anonymous"}`;
}

function readJson(key, fallback) {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(value));
  } catch {
    // Private windows and full storage only lose the convenience.
  }
}

/** The person's saved custom colors, newest first. */
export function customColors(userId) {
  const saved = readJson(storageKey("colors", userId), []);
  return Array.isArray(saved) ? saved.map(normalizeHex).filter(Boolean).slice(0, MAX_CUSTOM_COLORS) : [];
}

/** Saves `hex` as the person's newest custom color and returns the new list. */
export function saveCustomColor(userId, hex) {
  const color = normalizeHex(hex);
  const current = customColors(userId);
  if (!color) return current;
  const next = [color, ...current.filter((value) => value !== color)].slice(0, MAX_CUSTOM_COLORS);
  writeJson(storageKey("colors", userId), next);
  return next;
}

export function removeCustomColor(userId, hex) {
  const next = customColors(userId).filter((value) => value !== hex);
  writeJson(storageKey("colors", userId), next);
  return next;
}

/** The style keys each kind of object takes. */
const STYLE_KEYS = {
  sticky: ["fill", "color", "fontSize", "autoFit", "fontFamily"],
  text: ["color", "fontSize", "align", "fontFamily"],
  shape: ["fill", "stroke", "strokeWidth", "color", "fontSize", "align", "fontFamily"],
  frame: ["fill", "stroke"],
};

/** The kind an object's style is remembered and copied as, or null. */
export function styleKind(node) {
  if (isShapeNode(node)) return "shape";
  return STYLE_KEYS[node.type] ? node.type : null;
}

/** The style of `node`: its colors, line and text settings and opacity (copy style). */
export function styleOf(node) {
  const style = {};
  for (const key of STYLE_KEYS[styleKind(node)] ?? []) if (node[key] !== undefined) style[key] = node[key];
  if (node.type === "rect" && node.cornerRadius !== undefined) style.cornerRadius = node.cornerRadius;
  if (node.opacity !== undefined) style.opacity = node.opacity;
  return style;
}

let lastStyles = null;

/**
 * Remembers a style change made to objects of `kind`, so new objects of that
 * kind take it. Only the keys the kind takes are kept; opacity is not.
 */
export function rememberStyle(userId, kind, patch) {
  const keys = STYLE_KEYS[kind];
  if (!keys) return;
  const changes = Object.fromEntries(Object.entries(patch).filter(([key, value]) => keys.includes(key) && value !== undefined));
  if (!Object.keys(changes).length) return;
  const all = { ...lastStylesFor(userId) };
  const merged = { ...all[kind], ...changes };
  // A chosen font size replaces auto-fit, and turning auto-fit on replaces the size.
  if (changes.fontSize !== undefined && changes.autoFit === undefined) merged.autoFit = false;
  all[kind] = merged;
  lastStyles = { userId, styles: all };
  writeJson(storageKey("styles", userId), all);
}

function lastStylesFor(userId) {
  if (lastStyles?.userId === userId) return lastStyles.styles;
  const saved = readJson(storageKey("styles", userId), {});
  lastStyles = { userId, styles: saved && typeof saved === "object" ? saved : {} };
  return lastStyles.styles;
}

/** `node` (a new object) with the last style its person used on its kind. */
export function withLastStyle(node, userId) {
  const kind = styleKind(node);
  const style = kind && lastStylesFor(userId)[kind];
  if (!style) return node;
  const next = { ...node };
  for (const key of STYLE_KEYS[kind]) {
    if (style[key] === undefined) continue;
    if (key === "autoFit") {
      if (style.autoFit) next.autoFit = true;
      else delete next.autoFit;
    } else next[key] = style[key];
  }
  return next;
}

/** The types an object can switch to. */
export const SWITCH_TYPES = [
  { id: "sticky", name: "Sticky note" },
  { id: "text", name: "Text" },
  { id: "rect", name: "Rectangle" },
  { id: "ellipse", name: "Circle" },
  { id: "diamond", name: "Diamond" },
  { id: "triangle", name: "Triangle" },
];

export function canSwitchType(node) {
  return node.type === "sticky" || node.type === "text" || isShapeNode(node);
}

const TEXT_KEYS = ["text", "marks", "fontFamily"];
const TYPE_KEYS = ["type", "shape", "fill", "stroke", "strokeWidth", "cornerRadius", "align", "color", "fontSize", "autoFit",
  "showAuthor", "tagIds", "reactions", ...TEXT_KEYS];

/**
 * `node` as another type (see SWITCH_TYPES), keeping its id, place, size,
 * text, formatting, font and colors where the new type has them, so
 * connectors stay attached and one undo restores it.
 */
export function switchType(node, to) {
  if (!canSwitchType(node) || node.type === to) return node;
  // Everything but the type's own fields carries over (place, size, frame, group, stamps, and any newer field).
  const base = { ...node };
  for (const key of TYPE_KEYS) delete base[key];
  const text = {};
  for (const key of TEXT_KEYS) if (node[key] !== undefined) text[key] = node[key];
  const fill = node.fill && node.fill !== "transparent" && !node.fill.startsWith("rgba") ? node.fill : undefined;
  const fontSize = node.fontSize ?? 16;
  if (to === "sticky") {
    const color = STICKY_COLORS.find((entry) => entry.value === fill) ?? DEFAULT_STICKY_COLOR;
    const next = { ...base, type: "sticky", text: "", ...text, fill: fill ?? color.value, fontSize,
      color: fill ? node.color ?? color.ink : color.ink };
    if (node.type === "text") {
      // A text box becomes a square note around its text.
      next.w = next.h = Math.max(STICKY_SIDE / 2, Math.min(node.w, STICKY_SIDE * 2));
    }
    if (node.autoFit) next.autoFit = true;
    return next;
  }
  if (to === "text") {
    return { ...base, type: "text", text: "", ...text, fontSize, align: node.align ?? (isShapeNode(node) ? "center" : "left"),
      color: node.type === "sticky" ? "#ffffff" : node.color ?? "#ffffff" };
  }
  const shape = { ...base, type: to, ...text, fill: fill ?? "rgba(255,255,255,0.06)",
    stroke: node.stroke ?? "rgba(255,255,255,0.55)", strokeWidth: node.strokeWidth ?? 2 };
  if (node.fontSize !== undefined) shape.fontSize = node.fontSize;
  if (node.color !== undefined) shape.color = node.color;
  if (node.align !== undefined && node.align !== "left") shape.align = node.align;
  if (to === "rect" && node.type === "rect" && node.cornerRadius !== undefined) shape.cornerRadius = node.cornerRadius;
  if (!shape.text) {
    delete shape.text;
    delete shape.marks;
    delete shape.align;
  }
  return shape;
}
