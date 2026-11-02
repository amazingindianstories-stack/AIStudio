/**
 * Defensive validation of format objects and the format fields on other nodes.
 * Mirrors backend/apps/canvas/formats.py; shared fixture cases hold both to the same output.
 */
import {
  DOC_BLOCK_TYPES,
  FORMAT_KINDS,
  FORMAT_STATUSES,
  MAX_BLOCK_TEXT,
  MAX_CELL_TEXT,
  MAX_DOC_BLOCKS,
  MAX_DRAWIO_PREVIEW,
  MAX_DRAWIO_XML,
  MAX_HTML,
  MAX_ID,
  MAX_LANES,
  MAX_LANE_NAME,
  MAX_NAME,
  MAX_NOTES,
  MAX_SLIDES,
  MAX_SUGGESTIONS,
  MAX_TABLE_COLS,
  MAX_TABLE_ROWS,
  FORMAT_DEFAULTS,
  DRAWIO_PREVIEW_PREFIX,
} from "./model";
import { validateMarks } from "../rich-text";

const SUGGESTION_KINDS = ["replace", "delete"];
const SOURCE_MAX = 20000;
const MERMAID_KEY = /^[\w\u00C0-\uFFFF]+(?:-[\w\u00C0-\uFFFF]+)*$/;

function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

/** `text` with each unpaired surrogate replaced by U+FFFD, so it can be stored as JSON in PostgreSQL. */
function wellFormed(text) {
  return text.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]/g, (m) => (m.length === 2 ? m : "\uFFFD"));
}

/** A string within `max` UTF-16 units, else the fallback. */
function limited(value, max, fallback = "") {
  return typeof value === "string" && value.length <= max ? wellFormed(value) : fallback;
}

function identifier(value) {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ID ? wellFormed(value) : null;
}

/** Fields every status-bearing node shares; present only when set. */
export function withFormatStatus(node, r) {
  if (FORMAT_STATUSES.includes(r.status)) node.status = r.status;
  return node;
}

/** Mermaid source kept on a diagram so the code and the shapes stay editable together. */
export function withDiagramSource(node, r) {
  if (r.sourceKind === "mermaid" && typeof r.source === "string" && r.source.length <= SOURCE_MAX) {
    node.sourceKind = "mermaid";
    node.source = wellFormed(r.source);
  }
  return withFormatStatus(node, r);
}

/** The click-through link of a wireframe object: the id of the screen (frame) it opens. */
export function withScreenLink(node, r) {
  const id = identifier(r.screenLink);
  if (id) node.screenLink = id;
  return node;
}

/** The Mermaid node id a diagram shape was built from, so a code update keeps the shape's identity. */
export function withMermaidKey(node, r) {
  const key = identifier(r.mermaidKey);
  if (key && MERMAID_KEY.test(key)) node.mermaidKey = key;
  return node;
}

function validateBlocks(raw) {
  const blocks = [];
  const seen = new Set();
  for (const item of Array.isArray(raw) ? raw.slice(0, MAX_DOC_BLOCKS) : []) {
    if (item == null || typeof item !== "object") continue;
    const id = identifier(item.id);
    if (!id || seen.has(id) || !DOC_BLOCK_TYPES.includes(item.type)) continue;
    seen.add(id);
    const block = { id, type: item.type };
    if (item.type === "table") {
      const rows = [];
      const rawRows = Array.isArray(item.rows) ? item.rows.slice(0, MAX_TABLE_ROWS) : [];
      for (const row of rawRows) {
        if (!Array.isArray(row)) continue;
        rows.push(row.slice(0, MAX_TABLE_COLS).map((cell) => limited(cell, MAX_CELL_TEXT)));
      }
      const width = Math.max(1, ...rows.map((row) => row.length));
      block.rows = rows.length ? rows.map((row) => [...row, ...new Array(width - row.length).fill("")]) : [[""]];
    } else if (item.type === "diagram") {
      block.ref = identifier(item.ref) ?? "";
    } else {
      block.text = limited(item.text, MAX_BLOCK_TEXT);
      const marks = validateMarks(item.marks, block.text);
      if (marks) block.marks = marks;
      if (item.type === "todo" && item.checked === true) block.checked = true;
    }
    blocks.push(block);
  }
  if (!blocks.length) blocks.push({ id: "b1", type: "p", text: "" });
  return blocks;
}

function validateSuggestions(raw, blockIds) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(raw) ? raw.slice(0, MAX_SUGGESTIONS) : []) {
    if (item == null || typeof item !== "object") continue;
    const id = identifier(item.id);
    const blockId = identifier(item.blockId);
    if (!id || !blockId || seen.has(id) || !blockIds.has(blockId) || !SUGGESTION_KINDS.includes(item.kind)) continue;
    seen.add(id);
    const suggestion = {
      id,
      blockId,
      kind: item.kind,
      text: item.kind === "delete" ? "" : limited(item.text, MAX_BLOCK_TEXT),
      by: limited(item.by, MAX_ID),
      at: isFiniteNumber(item.at) ? item.at : 0,
    };
    const marks = item.kind === "replace" && validateMarks(item.marks, suggestion.text);
    if (marks) suggestion.marks = marks;
    out.push(suggestion);
  }
  return out;
}

function validateSlides(raw) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(raw) ? raw.slice(0, MAX_SLIDES) : []) {
    if (item == null || typeof item !== "object") continue;
    const id = identifier(item.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      title: limited(item.title, MAX_NAME),
      frameId: identifier(item.frameId) ?? "",
      notes: limited(item.notes, MAX_NOTES),
      lane: identifier(item.lane) ?? "main",
    });
  }
  return out;
}

function validateLanes(raw) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(raw) ? raw.slice(0, MAX_LANES) : []) {
    if (item == null || typeof item !== "object") continue;
    const id = identifier(item.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name: limited(item.name, MAX_LANE_NAME, "Lane") });
  }
  if (!out.some((lane) => lane.id === "main")) out.unshift({ id: "main", name: "Main" });
  return out.slice(0, MAX_LANES);
}

/** The `format` node type; null when its kind is unknown. */
export function validateFormatNode(r, base) {
  if (!FORMAT_KINDS.includes(r.format)) return null;
  const node = {
    ...base,
    type: "format",
    format: r.format,
    name: limited(r.name, MAX_NAME, FORMAT_DEFAULTS[r.format].name),
  };
  withFormatStatus(node, r);
  if (r.defaultView === true) {
    node.defaultView = true;
    if (r.viewLocked === true) node.viewLocked = true;
  }
  if (r.format === "doc") {
    node.blocks = validateBlocks(r.blocks);
    const suggestions = validateSuggestions(r.suggestions, new Set(node.blocks.map((b) => b.id)));
    if (suggestions.length) node.suggestions = suggestions;
  } else if (r.format === "deck") {
    node.slides = validateSlides(r.slides);
    node.lanes = validateLanes(r.lanes);
    const laneIds = new Set(node.lanes.map((lane) => lane.id));
    for (const slide of node.slides) if (!laneIds.has(slide.lane)) slide.lane = "main";
  } else if (r.format === "html") {
    node.html = limited(r.html, MAX_HTML);
  } else if (r.format === "drawio") {
    node.xml = limited(r.xml, MAX_DRAWIO_XML);
    const preview = limited(r.preview, MAX_DRAWIO_PREVIEW);
    if (preview.startsWith(DRAWIO_PREVIEW_PREFIX)) node.preview = preview;
  }
  return node;
}

/** After every node is known: screen links and slide frames that point nowhere are dropped. */
export function dropDanglingFormatRefs(nodes, nodeIds) {
  for (const n of nodes) {
    if (n.screenLink && !nodeIds.has(n.screenLink)) delete n.screenLink;
    if (n.type === "format" && n.format === "deck") {
      for (const slide of n.slides) if (slide.frameId && !nodeIds.has(slide.frameId)) slide.frameId = "";
    }
  }
}
