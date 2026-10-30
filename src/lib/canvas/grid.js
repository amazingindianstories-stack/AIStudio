/**
 * The grid widget: a table of up to 2,500 cells as one board object. A grid node stores its size
 * (`rows`, `cols`), the cells that hold anything (`cells`: `[row, col, text, fill, color]`, trailing
 * defaults left off) and merged ranges (`merges`: `[row, col, rowSpan, colSpan]`). Cells share the node's
 * box equally, so resizing the node resizes the table. Pure functions; the board's save path sees one
 * ordinary node.
 */

export const MAX_GRID_CELLS = 2500;
export const MAX_GRID_SIDE = 100;
export const MAX_CELL_TEXT = 1000;
export const GRID_CELL_W = 120;
export const GRID_CELL_H = 48;
export const GRID_FILLS = ["#2a2f3a", "#3b3320", "#1f3a2c", "#1f2f4a", "#4a2530", "#ffffff"];

const clampInt = (value, lo, hi) => Math.min(hi, Math.max(lo, Math.round(value)));

/** A new grid node of `rows` x `cols` cells centered at `center`. */
export function createGrid(rows, cols, center, id = crypto.randomUUID()) {
  const r = clampInt(rows, 1, MAX_GRID_SIDE);
  const c = Math.min(clampInt(cols, 1, MAX_GRID_SIDE), Math.floor(MAX_GRID_CELLS / r));
  const w = c * GRID_CELL_W;
  const h = r * GRID_CELL_H;
  return {
    id,
    type: "grid",
    x: center.x - w / 2,
    y: center.y - h / 2,
    w,
    h,
    rows: r,
    cols: c,
    cells: [],
    merges: [],
    stroke: "rgba(255,255,255,0.35)",
    parentId: null,
    groupId: null,
  };
}

export function normalizeRange(range) {
  return {
    r0: Math.min(range.r0, range.r1),
    c0: Math.min(range.c0, range.c1),
    r1: Math.max(range.r0, range.r1),
    c1: Math.max(range.c0, range.c1),
  };
}

function cellKey(r, c) {
  return `${r},${c}`;
}

/** The text and colors of one cell. */
export function cellAt(node, r, c) {
  const found = (node.cells ?? []).find((cell) => cell[0] === r && cell[1] === c);
  return { text: found?.[2] ?? "", fill: found?.[3] || null, color: found?.[4] || null };
}

function withCells(node, map) {
  const cells = [];
  for (const value of [...map.values()].sort((a, b) => a.r - b.r || a.c - b.c)) {
    const row = [value.r, value.c, value.text];
    if (value.fill || value.color) row.push(value.fill ?? "");
    if (value.color) row.push(value.color);
    if (value.text !== "" || value.fill || value.color) cells.push(row);
  }
  return { ...node, cells };
}

function cellMap(node) {
  const map = new Map();
  for (const [r, c, text, fill, color] of node.cells ?? []) map.set(cellKey(r, c), { r, c, text, fill: fill || null, color: color || null });
  return map;
}

function readCell(map, r, c) {
  return map.get(cellKey(r, c)) ?? { r, c, text: "", fill: null, color: null };
}

/** The grid with one cell's text set. */
export function setCellText(node, r, c, text) {
  if (r < 0 || c < 0 || r >= node.rows || c >= node.cols) return node;
  const map = cellMap(node);
  map.set(cellKey(r, c), { ...readCell(map, r, c), text: String(text).slice(0, MAX_CELL_TEXT) });
  return withCells(node, map);
}

/** The grid with a fill and/or text color set on every cell of `range` (`null` clears one). */
export function setRangeStyle(node, range, patch) {
  const { r0, c0, r1, c1 } = normalizeRange(range);
  const map = cellMap(node);
  for (let r = Math.max(0, r0); r <= Math.min(node.rows - 1, r1); r += 1) {
    for (let c = Math.max(0, c0); c <= Math.min(node.cols - 1, c1); c += 1) {
      const cell = readCell(map, r, c);
      map.set(cellKey(r, c), {
        ...cell,
        ...("fill" in patch ? { fill: patch.fill } : {}),
        ...("color" in patch ? { color: patch.color } : {}),
      });
    }
  }
  return withCells(node, map);
}

/** Every merge range overlapping `range`, folded in until the range is a union of whole merges. */
export function expandToMerges(node, range) {
  let current = normalizeRange(range);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [r, c, rs, cs] of node.merges ?? []) {
      const overlaps = r <= current.r1 && r + rs - 1 >= current.r0 && c <= current.c1 && c + cs - 1 >= current.c0;
      if (!overlaps) continue;
      const next = {
        r0: Math.min(current.r0, r),
        c0: Math.min(current.c0, c),
        r1: Math.max(current.r1, r + rs - 1),
        c1: Math.max(current.c1, c + cs - 1),
      };
      if (next.r0 !== current.r0 || next.c0 !== current.c0 || next.r1 !== current.r1 || next.c1 !== current.c1) {
        current = next;
        grew = true;
      }
    }
  }
  return current;
}

/** Merges the cells of `range` into one cell (text of the cells joined into the top-left one). */
export function mergeRange(node, range) {
  const { r0, c0, r1, c1 } = expandToMerges(node, range);
  if (r0 === r1 && c0 === c1) return node;
  const inside = ([r, c, rs, cs]) => r >= r0 && r + rs - 1 <= r1 && c >= c0 && c + cs - 1 <= c1;
  const merges = (node.merges ?? []).filter((m) => !inside(m));
  merges.push([r0, c0, r1 - r0 + 1, c1 - c0 + 1]);
  const map = cellMap(node);
  const texts = [];
  for (let r = r0; r <= r1; r += 1) {
    for (let c = c0; c <= c1; c += 1) {
      const text = readCell(map, r, c).text;
      if (text) texts.push(text);
      if (r !== r0 || c !== c0) map.delete(cellKey(r, c));
    }
  }
  const anchor = readCell(map, r0, c0);
  map.set(cellKey(r0, c0), { ...anchor, text: texts.join(" ").slice(0, MAX_CELL_TEXT) });
  return withCells({ ...node, merges }, map);
}

/** Splits every merged cell touching `range` back into single cells. */
export function unmergeRange(node, range) {
  const { r0, c0, r1, c1 } = normalizeRange(range);
  const merges = (node.merges ?? []).filter(([r, c, rs, cs]) => !(r <= r1 && r + rs - 1 >= r0 && c <= c1 && c + cs - 1 >= c0));
  return merges.length === (node.merges ?? []).length ? node : { ...node, merges };
}

/** The merge whose top-left or covered area holds (r, c), or null. */
export function mergeAt(node, r, c) {
  for (const m of node.merges ?? []) {
    if (r >= m[0] && r < m[0] + m[2] && c >= m[1] && c < m[1] + m[3]) return m;
  }
  return null;
}

/** What to draw: one entry per visible cell, merged cells as one larger cell. */
export function visibleCells(node) {
  const out = [];
  const map = cellMap(node);
  for (let r = 0; r < node.rows; r += 1) {
    for (let c = 0; c < node.cols; c += 1) {
      const merge = mergeAt(node, r, c);
      if (merge && (merge[0] !== r || merge[1] !== c)) continue;
      const cell = readCell(map, r, c);
      out.push({ r, c, rs: merge ? merge[2] : 1, cs: merge ? merge[3] : 1, text: cell.text, fill: cell.fill, color: cell.color });
    }
  }
  return out;
}

function shiftIndex(index, at, delta) {
  return index >= at ? index + delta : index;
}

/** Adds a row so it ends up at index `at` (0 to rows). Refuses past the cell cap. */
export function insertRow(node, at) {
  if ((node.rows + 1) * node.cols > MAX_GRID_CELLS || node.rows >= MAX_GRID_SIDE) return node;
  const index = clampInt(at, 0, node.rows);
  const cells = (node.cells ?? []).map(([r, ...rest]) => [shiftIndex(r, index, 1), ...rest]);
  const merges = (node.merges ?? []).map(([r, c, rs, cs]) => {
    if (r >= index) return [r + 1, c, rs, cs];
    if (r + rs > index) return [r, c, rs + 1, cs];
    return [r, c, rs, cs];
  });
  return { ...node, rows: node.rows + 1, h: node.h + node.h / node.rows, cells, merges };
}

export function insertColumn(node, at) {
  if (node.rows * (node.cols + 1) > MAX_GRID_CELLS || node.cols >= MAX_GRID_SIDE) return node;
  const index = clampInt(at, 0, node.cols);
  const cells = (node.cells ?? []).map(([r, c, ...rest]) => [r, shiftIndex(c, index, 1), ...rest]);
  const merges = (node.merges ?? []).map(([r, c, rs, cs]) => {
    if (c >= index) return [r, c + 1, rs, cs];
    if (c + cs > index) return [r, c, rs, cs + 1];
    return [r, c, rs, cs];
  });
  return { ...node, cols: node.cols + 1, w: node.w + node.w / node.cols, cells, merges };
}

/** Removes row `at`; the last row cannot be removed. */
export function removeRow(node, at) {
  if (node.rows <= 1 || at < 0 || at >= node.rows) return node;
  const cells = (node.cells ?? []).filter(([r]) => r !== at).map(([r, ...rest]) => [r > at ? r - 1 : r, ...rest]);
  const merges = [];
  for (const [r, c, rs, cs] of node.merges ?? []) {
    const end = r + rs - 1;
    if (at < r) merges.push([r - 1, c, rs, cs]);
    else if (at > end) merges.push([r, c, rs, cs]);
    else if (rs > 1) merges.push([r, c, rs - 1, cs]);
  }
  return { ...node, rows: node.rows - 1, h: node.h - node.h / node.rows, cells, merges: merges.filter(([, , rs, cs]) => rs * cs > 1) };
}

export function removeColumn(node, at) {
  if (node.cols <= 1 || at < 0 || at >= node.cols) return node;
  const cells = (node.cells ?? []).filter(([, c]) => c !== at).map(([r, c, ...rest]) => [r, c > at ? c - 1 : c, ...rest]);
  const merges = [];
  for (const [r, c, rs, cs] of node.merges ?? []) {
    const end = c + cs - 1;
    if (at < c) merges.push([r, c - 1, rs, cs]);
    else if (at > end) merges.push([r, c, rs, cs]);
    else if (cs > 1) merges.push([r, c, rs, cs - 1]);
  }
  return { ...node, cols: node.cols - 1, w: node.w - node.w / node.cols, cells, merges: merges.filter(([, , rs, cs]) => rs * cs > 1) };
}

// ---- spreadsheet paste ----

/** Rows of cell text from pasted CSV or TSV (a tab anywhere means tabs; quotes and doubled quotes are honored). */
export function parseDelimited(text) {
  const source = String(text ?? "").replace(/\r\n?/g, "\n").replace(/\n+$/, "");
  if (!source.trim()) return [];
  const delimiter = source.includes("\t") ? "\t" : ",";
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"' && cell === "") {
      quoted = true;
    } else if (ch === delimiter) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += ch;
    }
  }
  row.push(cell);
  rows.push(row);
  return rows;
}

/** A grid node filled from pasted CSV or TSV, or null when there is nothing to import. Trimmed to the cell cap. */
export function gridFromDelimited(text, center, id = crypto.randomUUID()) {
  const rows = parseDelimited(text);
  if (!rows.length) return null;
  const cols = Math.max(...rows.map((r) => r.length), 1);
  const keptRows = Math.min(rows.length, MAX_GRID_SIDE, Math.floor(MAX_GRID_CELLS / Math.min(cols, MAX_GRID_SIDE)));
  const node = createGrid(keptRows, cols, center, id);
  let next = node;
  for (let r = 0; r < node.rows; r += 1) {
    for (let c = 0; c < node.cols; c += 1) {
      const value = rows[r]?.[c];
      if (value) next = setCellText(next, r, c, value);
    }
  }
  return next;
}
