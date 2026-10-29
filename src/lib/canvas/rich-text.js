/**
 * Rich text for board text, stickies and shapes. `node.text` stays the plain
 * string; formatting lives beside it as compact ranges over that string:
 *
 *   marks: [[start, end, kind], [start, end, "h", "#fde047"], [start, end, "a", "https://…"]]
 *
 * Offsets are UTF-16 code units (JS string indices), `end` exclusive. Kinds:
 * b bold, i italic, u underline, s strikethrough, h highlight (#rrggbb),
 * a link (http, https or mailto). Boards without formatting carry no `marks`.
 *
 * Nothing here ever produces or stores HTML: the editor's DOM is read back
 * through `readRichDom`, which keeps only text and these marks, and display
 * renders `richSegments` as React elements.
 */

export const MAX_MARKS = 4000;
export const MAX_HREF_LENGTH = 2048;
export const SIMPLE_MARKS = ["b", "i", "u", "s"];
const KIND_ORDER = ["b", "i", "u", "s", "h", "a"];

// ASCII-only scheme match without the /i flag: case-insensitive regexes fold
// some non-ASCII letters differently in JS and Python, and the backend
// serializer must accept exactly the same links.
const SAFE_HREF = /^(?:[hH][tT][tT][pP][sS]?:\/\/|[mM][aA][iI][lL][tT][oO]:)[^\u0000- \u007f]+$/;
const HIGHLIGHT = /^#[0-9a-fA-F]{6}$/;

export const HIGHLIGHT_COLORS = [
  { value: "#fde047", name: "Yellow" },
  { value: "#86efac", name: "Green" },
  { value: "#93c5fd", name: "Blue" },
  { value: "#f9a8d4", name: "Pink" },
  { value: "#fdba74", name: "Orange" },
];
export const DEFAULT_HIGHLIGHT = HIGHLIGHT_COLORS[0].value;

/** Highlights paint at partial opacity so any text color stays readable. */
export function highlightBackground(hex) {
  return `${hex}8c`;
}

export function isSafeHref(href) {
  return typeof href === "string" && href.length <= MAX_HREF_LENGTH && SAFE_HREF.test(href);
}

export function isHighlightColor(value) {
  return typeof value === "string" && HIGHLIGHT.test(value);
}

/**
 * Format v1 coercion of a node's `marks` against its validated `text`:
 * malformed entries are dropped, ranges are clamped to the text, and only the
 * known kinds with valid values survive. Returns null when nothing remains.
 * Mirrored exactly by `backend/apps/canvas/serialization.py`.
 */
export function validateMarks(raw, text) {
  if (!Array.isArray(raw)) return null;
  const limit = text.length;
  const out = [];
  for (const entry of raw.slice(0, MAX_MARKS)) {
    if (!Array.isArray(entry) || entry.length < 3) continue;
    const [rawStart, rawEnd, kind] = entry;
    if (!Number.isInteger(rawStart) || !Number.isInteger(rawEnd)) continue;
    const start = Math.max(0, rawStart);
    const end = Math.min(limit, rawEnd);
    if (start >= end) continue;
    if (SIMPLE_MARKS.includes(kind)) out.push([start, end, kind]);
    else if (kind === "h" && isHighlightColor(entry[3])) out.push([start, end, "h", entry[3]]);
    else if (kind === "a" && isSafeHref(entry[3])) out.push([start, end, "a", entry[3]]);
  }
  return out.length ? out : null;
}

/**
 * Splits `text` at every mark boundary into display segments, each carrying
 * the formatting active over it. Overlapping same-kind marks resolve to the
 * one listed last.
 */
export function richSegments(text, marks) {
  if (!text) return [];
  if (!marks?.length) return [{ text, start: 0 }];
  const cuts = new Set([0, text.length]);
  for (const [start, end] of marks) {
    cuts.add(Math.min(start, text.length));
    cuts.add(Math.min(end, text.length));
  }
  const sorted = [...cuts].sort((a, b) => a - b);
  const segments = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const start = sorted[i];
    const end = sorted[i + 1];
    if (start >= end) continue;
    const segment = { text: text.slice(start, end), start };
    for (const [ms, me, kind, value] of marks) {
      if (ms <= start && me >= end) segment[kind] = value ?? true;
    }
    segments.push(segment);
  }
  return segments;
}

/** Canonical marks from per-character formatting runs. */
export function marksFromRuns(runs) {
  const out = [];
  for (const kind of KIND_ORDER) {
    let open = null;
    for (const run of runs) {
      const value = run.format[kind];
      if (open && value === open.value && run.start === open.end) {
        open.end = run.end;
        continue;
      }
      if (open) out.push(open);
      open = value ? { kind, start: run.start, end: run.end, value } : null;
    }
    if (open) out.push(open);
  }
  return out
    .filter((m) => m.end > m.start)
    .sort((a, b) => a.start - b.start || a.end - b.end || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind))
    .map((m) => (m.value === true ? [m.start, m.end, m.kind] : [m.start, m.end, m.kind, m.value]));
}

const BLOCK_TAGS = new Set(["DIV", "P", "LI", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE", "PRE"]);

/**
 * Reads a contentEditable subtree back into `{ text, marks }`. This is the
 * input sanitizer: only text and the six known formats survive; tags,
 * attributes, styles and links outside http/https/mailto are discarded.
 */
export function readRichDom(root) {
  let text = "";
  const runs = [];
  // Block boundaries request one line break, emitted only between content,
  // so nested and adjacent blocks never stack extra blank lines.
  let pendingBreak = false;
  let started = false;
  const flush = () => {
    if (pendingBreak && started) text += "\n";
    pendingBreak = false;
    started = true;
  };

  const visit = (node, format) => {
    if (node.nodeType === 3) {
      const data = node.data;
      if (!data) return;
      flush();
      runs.push({ start: text.length, end: text.length + data.length, format });
      text += data;
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node;
    const tag = el.tagName;
    if (tag === "BR") {
      const parent = el.parentNode;
      const inBlock = parent !== root && BLOCK_TAGS.has(parent?.tagName);
      // <div><br></div> is the browser's empty line: it holds a line, no character.
      if (inBlock && parent.childNodes.length === 1) {
        flush();
        return;
      }
      // A trailing <br> after content in a block only keeps that line open.
      if (inBlock && el === parent.lastChild && el.previousSibling) return;
      flush();
      text += "\n";
      return;
    }
    if (tag === "SCRIPT" || tag === "STYLE" || tag === "TEMPLATE") return;
    const block = BLOCK_TAGS.has(tag);
    if (block) pendingBreak = true;
    const next = elementFormat(el, format);
    for (const child of el.childNodes) visit(child, next);
    if (block) pendingBreak = true;
  };

  for (const child of root.childNodes) visit(child, {});
  return { text, marks: marksFromRuns(runs) };
}

function elementFormat(el, inherited) {
  const format = { ...inherited };
  const tag = el.tagName;
  if (tag === "B" || tag === "STRONG") format.b = true;
  if (tag === "I" || tag === "EM") format.i = true;
  if (tag === "U" || tag === "INS") format.u = true;
  if (tag === "S" || tag === "STRIKE" || tag === "DEL") format.s = true;
  if (tag === "MARK") format.h = DEFAULT_HIGHLIGHT;
  if (tag === "A") {
    const href = el.getAttribute("href");
    if (isSafeHref(href)) format.a = href;
    else delete format.a;
  }
  const style = el.style;
  if (style) {
    const weight = style.fontWeight;
    if (weight === "bold" || weight === "bolder" || Number(weight) >= 600) format.b = true;
    else if (weight === "normal" || weight === "lighter" || (weight && Number(weight) < 600)) delete format.b;
    if (style.fontStyle === "italic" || style.fontStyle === "oblique") format.i = true;
    else if (style.fontStyle === "normal") delete format.i;
    const decoration = `${style.textDecorationLine || ""} ${style.textDecoration || ""}`;
    if (decoration.includes("underline")) format.u = true;
    if (decoration.includes("line-through")) format.s = true;
    if (/\bnone\b/.test(decoration) && !decoration.includes("underline") && !decoration.includes("line-through")) {
      delete format.u;
      delete format.s;
    }
    const background = style.backgroundColor;
    if (background) {
      const hex = cssColorToHex(background);
      if (hex) format.h = hex;
      else delete format.h;
    }
  }
  return format;
}

/** `#rrggbb` for an opaque CSS color, or null for transparent/unknown. */
export function cssColorToHex(value) {
  const color = String(value).trim().toLowerCase();
  if (isHighlightColor(color)) return color;
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(color);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
  const long = /^#([0-9a-f]{6})([0-9a-f]{2})$/.exec(color);
  if (long) return parseInt(long[2], 16) > 0 ? `#${long[1]}` : null;
  const rgb = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(color);
  if (!rgb) return null;
  if (rgb[4] !== undefined) {
    const alpha = rgb[4].endsWith("%") ? Number(rgb[4].slice(0, -1)) / 100 : Number(rgb[4]);
    if (!(alpha > 0)) return null;
  }
  const hex = (n) => Math.min(255, Number(n)).toString(16).padStart(2, "0");
  return `#${hex(rgb[1])}${hex(rgb[2])}${hex(rgb[3])}`;
}

/**
 * Fills an editor element with `text` and `marks` using DOM APIs only (no
 * innerHTML). Formats nest as a > span(highlight) > b > i > u > s > text,
 * which `readRichDom` reads back to the same value.
 */
export function writeRichDom(root, text, marks) {
  const doc = root.ownerDocument;
  while (root.firstChild) root.removeChild(root.firstChild);
  for (const segment of richSegments(text, marks)) {
    let node = doc.createTextNode(segment.text);
    for (const [kind, tag] of [["s", "s"], ["u", "u"], ["i", "i"], ["b", "b"]]) {
      if (!segment[kind]) continue;
      const wrapper = doc.createElement(tag);
      wrapper.appendChild(node);
      node = wrapper;
    }
    if (segment.h) {
      const wrapper = doc.createElement("span");
      wrapper.style.backgroundColor = highlightBackground(segment.h);
      wrapper.appendChild(node);
      node = wrapper;
    }
    if (segment.a) {
      const wrapper = doc.createElement("a");
      wrapper.setAttribute("href", segment.a);
      wrapper.appendChild(node);
      node = wrapper;
    }
    root.appendChild(node);
  }
}

/** Plain-text paste: the only way clipboard content enters an editor. */
export function plainTextFromClipboard(data) {
  return (data?.getData("text/plain") ?? "").replace(/\r\n?/g, "\n");
}
