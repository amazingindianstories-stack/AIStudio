/**
 * Validation of the newer board object kinds (ink strokes, grids, synced copies), the frame `hidden` flag
 * and the board-level visual notes, kept apart from serialization.js so that file only dispatches here.
 * Mirrored by backend/apps/canvas/extras.py: both sides must accept and drop exactly the same input.
 */
import { MAX_INK_NUMBERS } from "./ink";
import { MAX_CELL_TEXT, MAX_GRID_CELLS, MAX_GRID_SIDE } from "./grid";
import { validateMarks } from "./rich-text";

export const MAX_NOTES_TEXT = 200000;
export const MAX_NOTES_REFS = 50;
export const MAX_REF_LABEL = 120;
export const MAX_SYNCED_NAME = 200;
const ID_LENGTH = 64;

function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function isInt(v, lo, hi) {
  return Number.isInteger(v) && v >= lo && v <= hi;
}

function str(v, fallback) {
  return typeof v === "string" ? v : fallback;
}

function round1(v) {
  return Math.round(v * 10) / 10;
}

/** Fields of an `ink` node beyond the base box, or null when the stroke holds no usable points. */
export function validateInk(r, base) {
  if (!Array.isArray(r.pts) || r.pts.length < 2 || r.pts.length > MAX_INK_NUMBERS) return null;
  const pts = r.pts.length % 2 === 0 ? r.pts : r.pts.slice(0, -1);
  if (!pts.every(isFiniteNumber)) return null;
  const node = {
    ...base,
    type: "ink",
    pts: pts.map(round1),
    vw: isFiniteNumber(r.vw) && r.vw > 0 ? r.vw : Math.max(base.w, 1),
    vh: isFiniteNumber(r.vh) && r.vh > 0 ? r.vh : Math.max(base.h, 1),
    stroke: str(r.stroke, "#ffffff"),
    strokeWidth: isFiniteNumber(r.strokeWidth) ? Math.min(100, Math.max(0.5, r.strokeWidth)) : 2,
  };
  if (r.highlighter === true) node.highlighter = true;
  return node;
}

function validateCells(raw, rows, cols) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const cells = [];
  for (const entry of raw) {
    if (cells.length >= MAX_GRID_CELLS) break;
    if (!Array.isArray(entry) || entry.length < 3) continue;
    const [r, c, text, fill, color] = entry;
    if (!isInt(r, 0, rows - 1) || !isInt(c, 0, cols - 1) || typeof text !== "string") continue;
    const key = `${r},${c}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const cell = [r, c, text.slice(0, MAX_CELL_TEXT)];
    const hasFill = typeof fill === "string" && fill !== "";
    const hasColor = typeof color === "string" && color !== "";
    if (hasFill || hasColor) cell.push(hasFill ? fill : "");
    if (hasColor) cell.push(color);
    cells.push(cell);
  }
  return cells;
}

function validateMerges(raw, rows, cols) {
  if (!Array.isArray(raw)) return [];
  const merges = [];
  const taken = new Set();
  for (const entry of raw) {
    if (merges.length >= MAX_GRID_CELLS) break;
    if (!Array.isArray(entry) || entry.length < 4) continue;
    const [r, c, rs, cs] = entry;
    if (!isInt(r, 0, rows - 1) || !isInt(c, 0, cols - 1) || !isInt(rs, 1, rows) || !isInt(cs, 1, cols)) continue;
    if (rs * cs < 2 || r + rs > rows || c + cs > cols) continue;
    const covered = [];
    let overlaps = false;
    for (let i = r; i < r + rs && !overlaps; i += 1) {
      for (let j = c; j < c + cs; j += 1) {
        if (taken.has(`${i},${j}`)) {
          overlaps = true;
          break;
        }
        covered.push(`${i},${j}`);
      }
    }
    if (overlaps) continue;
    for (const key of covered) taken.add(key);
    merges.push([r, c, rs, cs]);
  }
  return merges;
}

/** Fields of a `grid` node, or null when its size is outside the limits. */
export function validateGrid(r, base) {
  if (!isInt(r.rows, 1, MAX_GRID_SIDE) || !isInt(r.cols, 1, MAX_GRID_SIDE) || r.rows * r.cols > MAX_GRID_CELLS) return null;
  return {
    ...base,
    type: "grid",
    rows: r.rows,
    cols: r.cols,
    cells: validateCells(r.cells, r.rows, r.cols),
    merges: validateMerges(r.merges, r.rows, r.cols),
    stroke: str(r.stroke, "rgba(255,255,255,0.35)"),
  };
}

/** Fields of a `synced` node (a view-only reference to a frame on a board), or null without both ids. */
export function validateSynced(r, base) {
  const board = r.sourceBoardId;
  const source = r.sourceNodeId;
  if (typeof board !== "string" || !board || board.length > ID_LENGTH) return null;
  if (typeof source !== "string" || !source || source.length > ID_LENGTH) return null;
  const node = { ...base, type: "synced", sourceBoardId: board, sourceNodeId: source };
  if (typeof r.name === "string") node.name = r.name.slice(0, MAX_SYNCED_NAME);
  return node;
}

/** The board's visual notes: text with rich-text marks and embedded object references, or null for nothing. */
export function validateNotes(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const text = typeof raw.text === "string" ? raw.text.slice(0, MAX_NOTES_TEXT) : "";
  const refs = [];
  const seen = new Set();
  for (const item of Array.isArray(raw.refs) ? raw.refs : []) {
    if (refs.length >= MAX_NOTES_REFS) break;
    if (item === null || typeof item !== "object") continue;
    const { id, label, type } = item;
    if (typeof id !== "string" || !id || id.length > ID_LENGTH || seen.has(id)) continue;
    seen.add(id);
    refs.push({ id, type: typeof type === "string" ? type.slice(0, 20) : "", label: typeof label === "string" ? label.slice(0, MAX_REF_LABEL) : "" });
  }
  if (!text && !refs.length) return null;
  const notes = { text };
  const marks = validateMarks(raw.marks, text);
  if (marks) notes.marks = marks;
  if (refs.length) notes.refs = refs;
  if (typeof raw.updatedBy === "string") notes.updatedBy = raw.updatedBy;
  if (isFiniteNumber(raw.updatedAt)) notes.updatedAt = raw.updatedAt;
  return notes;
}
