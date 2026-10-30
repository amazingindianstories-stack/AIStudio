/**
 * Sticky note helpers: the sticky palette and shapes, the batches bulk mode
 * and spreadsheet paste lay out, the sticky a stack hands out, CSV export and
 * clustering. Everything here is pure and works on the board model (never
 * the DOM), so it covers stickies the viewport has culled too.
 */
import { tagsOf } from "./tags";

/** Sixteen fixed sticky colors, each with the text color that stays readable on it. */
export const STICKY_COLORS = [
  { value: "#e3c56a", name: "Yellow", ink: "#1c1a12" },
  { value: "#f3e7a1", name: "Light yellow", ink: "#1c1a12" },
  { value: "#d99a5b", name: "Orange", ink: "#1c1a12" },
  { value: "#f2c29b", name: "Peach", ink: "#1c1a12" },
  { value: "#7fae86", name: "Green", ink: "#1c1a12" },
  { value: "#bfdcb0", name: "Light green", ink: "#1c1a12" },
  { value: "#5fb3a8", name: "Teal", ink: "#1c1a12" },
  { value: "#6f9bd1", name: "Blue", ink: "#1c1a12" },
  { value: "#b5cdee", name: "Light blue", ink: "#1c1a12" },
  { value: "#9b86c9", name: "Purple", ink: "#1c1a12" },
  { value: "#d2c4ec", name: "Lavender", ink: "#1c1a12" },
  { value: "#d189a7", name: "Pink", ink: "#1c1a12" },
  { value: "#f1c3d4", name: "Light pink", ink: "#1c1a12" },
  { value: "#c97a72", name: "Red", ink: "#1c1a12" },
  { value: "#e6e3dc", name: "Paper", ink: "#1c1a12" },
  { value: "#3a3a3a", name: "Charcoal", ink: "#f5f5f5" },
];
export const DEFAULT_STICKY_COLOR = STICKY_COLORS[0];
const INKS = new Set(STICKY_COLORS.map((color) => color.ink));

/** Side of a square sticky; a rectangular one is wider by RECTANGLE_RATIO. */
export const STICKY_SIDE = 200;
const RECTANGLE_RATIO = 1.75;
const GAP = 20;

/** Most stickies one spreadsheet paste makes (50 rows of 100 columns). */
export const MAX_PASTE_ROWS = 50;
export const MAX_PASTE_COLUMNS = 100;
/** Most lines bulk mode turns into stickies at once. */
export const MAX_BULK_STICKIES = 500;

export function stickyColorName(fill) {
  return STICKY_COLORS.find((color) => color.value === fill.toLowerCase())?.name ?? fill;
}

/**
 * The style patch for a sticky palette color: the fill, and the color's ink
 * as the text color when the text still has a palette ink (a custom text
 * color is kept).
 */
export function stickyColorPatch(node, fill) {
  const color = STICKY_COLORS.find((entry) => entry.value === fill);
  const patch = { fill };
  if (color && (!node.color || INKS.has(node.color.toLowerCase()))) patch.color = color.ink;
  return patch;
}

export function stickyShape(node) {
  return node.w > node.h * 1.2 ? "rectangle" : "square";
}

/** The sticky as a square or rectangle of the same height, keeping its top-left corner. */
export function withStickyShape(node, shape) {
  const w = shape === "rectangle" ? Math.round(node.h * RECTANGLE_RATIO) : node.h;
  return w === node.w ? node : { ...node, w };
}

/** A new sticky at (x, y) taking `style` (fill, color, fontSize, autoFit, fontFamily) from the caller. */
export function newSticky(x, y, text, style, id = crypto.randomUUID()) {
  const node = {
    id,
    type: "sticky",
    x,
    y,
    w: style.w ?? STICKY_SIDE,
    h: style.h ?? STICKY_SIDE,
    opacity: 1,
    parentId: null,
    groupId: null,
    text,
    fill: style.fill ?? DEFAULT_STICKY_COLOR.value,
    fontSize: style.fontSize ?? 16,
    color: style.color ?? DEFAULT_STICKY_COLOR.ink,
  };
  if (style.autoFit) node.autoFit = true;
  if (style.fontFamily) node.fontFamily = style.fontFamily;
  return node;
}

/**
 * Stickies for a grid of texts (rows of cells), centered on `center`, one per
 * non-blank cell and keeping each cell's row and column. Blank cells leave
 * their place empty.
 */
export function stickiesFromGrid(rows, center, style) {
  const w = style.w ?? STICKY_SIDE;
  const h = style.h ?? STICKY_SIDE;
  const columns = Math.max(0, ...rows.map((row) => row.length));
  const left = center.x - (columns * (w + GAP) - GAP) / 2;
  const top = center.y - (rows.length * (h + GAP) - GAP) / 2;
  const nodes = [];
  rows.forEach((row, r) => {
    row.forEach((cell, c) => {
      const text = cell.trim();
      if (text) nodes.push(newSticky(left + c * (w + GAP), top + r * (h + GAP), text, style));
    });
  });
  return nodes;
}

/** Bulk mode: one sticky per non-blank line, in a near-square grid. */
export function bulkStickies(text, center, style) {
  const lines = text.split(/\r\n?|\n/).map((line) => line.trim()).filter(Boolean).slice(0, MAX_BULK_STICKIES);
  const columns = Math.ceil(Math.sqrt(lines.length));
  const rows = [];
  for (let i = 0; i < lines.length; i += columns) rows.push(lines.slice(i, i + columns));
  return stickiesFromGrid(rows, center, style);
}

/**
 * The cells of tab-separated text, as spreadsheets put on the clipboard: a
 * quoted cell may hold tabs, newlines and doubled quotes. Null for text with
 * no tab, which is not a block of cells.
 */
export function parseTsv(text) {
  if (!text.includes("\t")) return null;
  const source = text.replace(/\r\n?/g, "\n").replace(/\n$/, "");
  const rows = [];
  let row = [];
  let i = 0;
  for (;;) {
    let cell;
    if (source[i] === '"') {
      let j = i + 1;
      let value = "";
      let closed = false;
      while (j < source.length) {
        if (source[j] === '"') {
          if (source[j + 1] === '"') {
            value += '"';
            j += 2;
            continue;
          }
          closed = true;
          j++;
          break;
        }
        value += source[j++];
      }
      // A quote that does not close at a cell's end was part of an unquoted cell.
      if (closed && (j === source.length || source[j] === "\t" || source[j] === "\n")) {
        cell = value;
        i = j;
      }
    }
    if (cell === undefined) {
      let j = i;
      while (j < source.length && source[j] !== "\t" && source[j] !== "\n") j++;
      cell = source.slice(i, j);
      i = j;
    }
    row.push(cell);
    if (i >= source.length) {
      rows.push(row);
      return rows;
    }
    if (source[i] === "\n") {
      rows.push(row);
      row = [];
    }
    i++;
  }
}

/** Rows cut to the paste limits, with whether anything was cut. */
export function limitCells(rows) {
  const truncated = rows.length > MAX_PASTE_ROWS || rows.some((row) => row.length > MAX_PASTE_COLUMNS);
  return { rows: rows.slice(0, MAX_PASTE_ROWS).map((row) => row.slice(0, MAX_PASTE_COLUMNS)), truncated };
}

/**
 * The sticky a stack hands out: blank, in the stack's color, the size of a
 * square sticky, centered on `center`.
 */
export function stickyFromStack(stack, center, style) {
  return newSticky(center.x - STICKY_SIDE / 2, center.y - STICKY_SIDE / 2, "", {
    ...style,
    fill: stack.fill,
    color: STICKY_COLORS.find((color) => color.value === stack.fill)?.ink ?? style.color,
  });
}

/** Who wrote a sticky's text: whoever last replaced it, else its creator. */
export function stickyAuthor(node) {
  return node.textBy ?? node.createdBy ?? null;
}

function csvCell(value) {
  let text = String(value ?? "");
  // A cell a spreadsheet would run as a formula is kept as text.
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * CSV of the stickies among `nodes` (in board order): text, color, tags and
 * author, with a byte order mark so spreadsheet apps read it as UTF-8.
 */
export function stickiesCsv(nodes, tags, personName) {
  const lines = [["Text", "Color", "Tags", "Author"].join(",")];
  for (const node of nodes) {
    if (node.type !== "sticky") continue;
    const author = stickyAuthor(node);
    lines.push([
      node.text,
      stickyColorName(node.fill),
      tagsOf(node, tags).map((tag) => tag.name).join("; "),
      author ? personName(author) : "",
    ].map(csvCell).join(","));
  }
  return `﻿${lines.join("\r\n")}\r\n`;
}

/**
 * The groups clustering makes of `stickies`, by "tag" (the first tag a
 * sticky got), "color" or "author". Each group is `{key, title,
 * nodes}`, in tag-table, palette or name order, with the group of stickies
 * that have no tag or no known author last.
 */
export function clusterGroups(stickies, by, { tags = [], personName = (id) => id } = {}) {
  const groups = new Map();
  const add = (key, title, node) => {
    if (!groups.has(key)) groups.set(key, { key, title, nodes: [] });
    groups.get(key).nodes.push(node);
  };
  for (const node of stickies) {
    if (by === "tag") {
      const tag = tagsOf(node, tags)[0];
      add(tag ? tag.id : "", tag ? tag.name : "No tag", node);
    } else if (by === "color") {
      add(node.fill.toLowerCase(), stickyColorName(node.fill), node);
    } else {
      const author = stickyAuthor(node);
      add(author ?? "", author ? personName(author) : "Unknown author", node);
    }
  }
  const rank = (group) => {
    if (!group.key) return Infinity;
    if (by === "tag") return tags.findIndex((tag) => tag.id === group.key);
    if (by === "color") {
      const index = STICKY_COLORS.findIndex((color) => color.value === group.key);
      return index === -1 ? STICKY_COLORS.length : index;
    }
    return 0;
  };
  return [...groups.values()].sort((a, b) => rank(a) - rank(b) || (by === "author" && a.key && b.key ? a.title.localeCompare(b.title) : 0));
}

const TITLE_HEIGHT = 40;
const TITLE_GAP = 12;
const GROUP_GAP = 80;

/**
 * Lays `groups` out left to right from `origin` (the selection's top-left):
 * each group a titled near-square grid of its stickies. Returns the stickies'
 * new positions (`Map` of id to {x, y}) and a text node for each title.
 */
export function clusterLayout(groups, origin, titleStyle) {
  const positions = new Map();
  const titles = [];
  let x = origin.x;
  for (const group of groups) {
    const cellW = Math.max(...group.nodes.map((node) => node.w));
    const cellH = Math.max(...group.nodes.map((node) => node.h));
    const columns = Math.ceil(Math.sqrt(group.nodes.length));
    const top = origin.y + TITLE_HEIGHT + TITLE_GAP;
    group.nodes.forEach((node, index) => {
      positions.set(node.id, { x: x + (index % columns) * (cellW + GAP), y: top + Math.floor(index / columns) * (cellH + GAP) });
    });
    const width = columns * (cellW + GAP) - GAP;
    const title = `${group.title} (${group.nodes.length})`;
    titles.push({
      id: crypto.randomUUID(),
      type: "text",
      x,
      y: origin.y,
      w: Math.max(width, 160),
      h: TITLE_HEIGHT,
      opacity: 1,
      parentId: null,
      groupId: null,
      text: title,
      marks: [[0, title.length, "b"]],
      fontSize: 24,
      align: "left",
      color: titleStyle.color,
    });
    x += Math.max(width, 160) + GROUP_GAP;
  }
  return { positions, titles };
}
