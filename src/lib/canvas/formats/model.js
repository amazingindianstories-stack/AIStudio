/**
 * Format objects: board objects of `type: "format"` that hold a Doc, a Slides
 * deck, an HTML embed or a draw.io diagram. They are ordinary board nodes saved
 * through the per-node save path, so they obey roles, culling and the 2 Mi limit.
 * Limits here are mirrored by backend/apps/canvas/serialization.py.
 */
import { clipText, validateMarks } from "../rich-text";

export const FORMAT_KINDS = ["doc", "deck", "html", "drawio"];
export const FORMAT_STATUSES = ["draft", "in_review", "approved", "done", "outdated"];
export const STATUS_LABELS = {
  draft: "Draft",
  in_review: "In review",
  approved: "Approved",
  done: "Done",
  outdated: "Outdated",
};

export const DOC_BLOCK_TYPES = ["p", "h1", "h2", "h3", "ul", "ol", "todo", "quote", "code", "table", "diagram"];

export const MAX_ID = 64;
export const MAX_NAME = 120;
export const MAX_DOC_BLOCKS = 400;
export const MAX_BLOCK_TEXT = 5000;
export const MAX_TABLE_ROWS = 20;
export const MAX_TABLE_COLS = 8;
export const MAX_CELL_TEXT = 500;
export const MAX_SUGGESTIONS = 200;
export const MAX_SLIDES = 100;
export const MAX_LANES = 6;
export const MAX_LANE_NAME = 60;
export const MAX_NOTES = 5000;
export const MAX_HTML = 50000;
export const MAX_DRAWIO_XML = 100000;
export const MAX_DRAWIO_PREVIEW = 100000;
export const DRAWIO_PREVIEW_PREFIX = "data:image/svg+xml;base64,";

export const FORMAT_DEFAULTS = {
  doc: { name: "Untitled doc", w: 420, h: 520 },
  deck: { name: "Untitled slides", w: 420, h: 300 },
  html: { name: "HTML embed", w: 480, h: 360 },
  drawio: { name: "Draw.io diagram", w: 480, h: 360 },
};

export function isFormatNode(node) {
  return node?.type === "format";
}

/** Formats that can carry a status: formats, and diagrams made from Mermaid code. */
export function canHaveStatus(node) {
  return node?.type === "format" || node?.type === "diagram";
}

function newId() {
  return globalThis.crypto.randomUUID();
}

export function newBlock(type = "p", text = "") {
  const block = { id: newId(), type, text };
  if (type === "table") {
    delete block.text;
    block.rows = [
      ["", ""],
      ["", ""],
    ];
  }
  if (type === "diagram") {
    delete block.text;
    block.ref = "";
  }
  return block;
}

export function newFormatNode(kind, center, extra = {}) {
  const d = FORMAT_DEFAULTS[kind];
  const node = {
    id: newId(),
    type: "format",
    format: kind,
    x: Math.round(center.x - d.w / 2),
    y: Math.round(center.y - d.h / 2),
    w: d.w,
    h: d.h,
    name: d.name,
    parentId: null,
    groupId: null,
  };
  if (kind === "doc") {
    node.blocks = [newBlock("h1", d.name), newBlock("p", "")];
  } else if (kind === "deck") {
    node.slides = [];
    node.lanes = [{ id: "main", name: "Main" }];
  } else if (kind === "html") {
    node.html = "<h2>Hello</h2>\n<p>Edit this HTML.</p>";
  } else if (kind === "drawio") {
    node.xml = "";
  }
  return { ...node, ...extra };
}

// ---- status and default view ----

/**
 * The status shown for the whole board: the default-view format's status, else
 * the least finished status among formats (Outdated, Draft, In review, Approved, Done).
 */
export function boardStatus(nodes) {
  const withStatus = nodes.filter((n) => canHaveStatus(n) && n.status);
  if (!withStatus.length) return null;
  const view = withStatus.find((n) => n.defaultView);
  if (view) return view.status;
  const order = ["outdated", "draft", "in_review", "approved", "done"];
  return withStatus.map((n) => n.status).sort((a, b) => order.indexOf(a) - order.indexOf(b))[0];
}

export function defaultViewNode(nodes) {
  return nodes.find((n) => isFormatNode(n) && n.defaultView) ?? null;
}

/**
 * Patches that make `id` the board's default view (every other format loses it),
 * or clear it. A locked default view opens in focus mode for viewers and editors alike.
 */
export function defaultViewPatches(nodes, id, { on, locked = false }) {
  const patches = [];
  for (const n of nodes) {
    if (!isFormatNode(n)) continue;
    if (n.id === id) {
      patches.push({ id, patch: on ? { defaultView: true, viewLocked: locked ? true : undefined } : { defaultView: undefined, viewLocked: undefined } });
    } else if (on && n.defaultView) {
      patches.push({ id: n.id, patch: { defaultView: undefined, viewLocked: undefined } });
    }
  }
  return patches;
}

// ---- doc blocks ----

export function insertBlockAfter(blocks, afterId, block) {
  if (blocks.length >= MAX_DOC_BLOCKS) return blocks;
  const at = blocks.findIndex((b) => b.id === afterId);
  const next = [...blocks];
  next.splice(at < 0 ? next.length : at + 1, 0, block);
  return next;
}

export function updateBlock(blocks, id, patch) {
  return blocks.map((b) => (b.id === id ? { ...b, ...patch } : b));
}

export function removeBlock(blocks, id) {
  const next = blocks.filter((b) => b.id !== id);
  return next.length ? next : [newBlock("p", "")];
}

export function moveBlock(blocks, id, delta) {
  const from = blocks.findIndex((b) => b.id === id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= blocks.length) return blocks;
  const next = [...blocks];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

/** Markdown-style typing shortcuts: "# " heading, "- " bullet, "1. " number, "[] " checklist, "> " quote. */
const SHORTCUTS = [
  [/^### /, "h3"],
  [/^## /, "h2"],
  [/^# /, "h1"],
  [/^[-*] /, "ul"],
  [/^1\. /, "ol"],
  [/^\[ ?\] /, "todo"],
  [/^> /, "quote"],
  [/^```/, "code"],
];

/** `block` with new text; its marks are kept only where they fit that text. */
export function setBlockText(block, text, marks) {
  const next = { ...block, text };
  delete next.marks;
  const valid = validateMarks(marks, text);
  if (valid) next.marks = valid;
  return next;
}

/** `block` with typed text and marks, a paragraph turned into another block by its typing shortcut. */
export function applyBlockShortcut(block, text, marks) {
  if (block.type === "p") {
    for (const [pattern, type] of SHORTCUTS) {
      const cut = pattern.exec(text)?.[0].length;
      if (cut) return setBlockText({ ...block, type }, text.slice(cut), marks?.map(([start, end, ...rest]) => [start - cut, end - cut, ...rest]));
    }
  }
  return setBlockText(block, text, marks);
}

/** The number shown before each block: its place in its run of numbered items, else 0. */
export function listNumbers(blocks) {
  let number = 0;
  return blocks.map((b) => (number = b.type === "ol" ? number + 1 : 0));
}

export function setTableCell(rows, r, c, value) {
  return rows.map((row, ri) => (ri === r ? row.map((cell, ci) => (ci === c ? clipText(value, MAX_CELL_TEXT) : cell)) : row));
}

export function addTableRow(rows) {
  if (rows.length >= MAX_TABLE_ROWS) return rows;
  return [...rows, new Array(rows[0]?.length ?? 2).fill("")];
}

export function addTableColumn(rows) {
  if ((rows[0]?.length ?? 0) >= MAX_TABLE_COLS) return rows;
  return rows.map((row) => [...row, ""]);
}

export function removeTableRow(rows) {
  return rows.length > 1 ? rows.slice(0, -1) : rows;
}

export function removeTableColumn(rows) {
  return (rows[0]?.length ?? 0) > 1 ? rows.map((row) => row.slice(0, -1)) : rows;
}

// ---- inline chips: people and dates ----

const USER_CHIP = /@\[([^\]\n]{1,80})\]\(user:([A-Za-z0-9_-]{1,64})\)/g;
const DATE_CHIP = /\{\{date:(\d{4}-\d{2}-\d{2})\}\}/g;

export function userChip(name, id) {
  return `@[${name.replace(/[\]\n]/g, "")}](user:${id})`;
}

export function dateChip(isoDate) {
  return `{{date:${isoDate}}}`;
}

/** Splits text into plain (with its offset), user and date parts for rendering. */
export function parseChips(text) {
  const parts = [];
  const all = [];
  for (const m of text.matchAll(USER_CHIP)) all.push({ index: m.index, length: m[0].length, part: { kind: "user", name: m[1], id: m[2] } });
  for (const m of text.matchAll(DATE_CHIP)) {
    if (!Number.isNaN(Date.parse(m[1]))) all.push({ index: m.index, length: m[0].length, part: { kind: "date", date: m[1] } });
  }
  all.sort((a, b) => a.index - b.index);
  let at = 0;
  for (const item of all) {
    if (item.index < at) continue;
    if (item.index > at) parts.push({ kind: "text", text: text.slice(at, item.index), start: at });
    parts.push(item.part);
    at = item.index + item.length;
  }
  if (at < text.length) parts.push({ kind: "text", text: text.slice(at), start: at });
  return parts;
}

export function formatChipDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

// ---- suggestions (suggest changes) ----

/** A suggestion proposes new text and marks for a block ("replace") or its removal ("delete"). */
export function addSuggestion(suggestions, { blockId, kind, text = "", marks, by }) {
  if (suggestions.length >= MAX_SUGGESTIONS) return suggestions;
  const clean = suggestions.filter((s) => !(s.blockId === blockId && s.kind === kind && s.by === by));
  const suggestion = { id: newId(), blockId, kind, text, by, at: Date.now() };
  const valid = kind === "replace" && validateMarks(marks, text);
  if (valid) suggestion.marks = valid;
  return [...clean, suggestion];
}

export function acceptSuggestion(blocks, suggestions, id) {
  const s = suggestions.find((item) => item.id === id);
  if (!s) return { blocks, suggestions };
  let next = blocks;
  if (s.kind === "replace") next = blocks.map((b) => (b.id === s.blockId ? setBlockText(b, s.text, s.marks) : b));
  else if (s.kind === "delete") next = removeBlock(blocks, s.blockId);
  const gone = s.kind === "delete" ? (x) => x.id === id || x.blockId === s.blockId : (x) => x.id === id;
  return { blocks: next, suggestions: suggestions.filter((x) => !gone(x)) };
}

export function rejectSuggestion(suggestions, id) {
  return suggestions.filter((s) => s.id !== id);
}
