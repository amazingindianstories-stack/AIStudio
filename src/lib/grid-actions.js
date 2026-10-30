"use client";

import { useCanvasStore } from "./canvas-store";
import { GRID_FILLS, createGrid, gridFromDelimited, insertColumn, insertRow, mergeRange, removeColumn, removeRow, setCellText, setRangeStyle, unmergeRange } from "./canvas/grid";

// Editing a grid widget: every change replaces the grid node whole through the board store, so it is one undo
// step, one saved node and respects the board role like any other edit.

/** Applies `change(node)` to the grid with this id. `coalesce` joins rapid edits (typing) into one undo step. */
export function editGrid(id, change, opts) {
  useCanvasStore.getState().editBoard((graph) => ({
    ...graph,
    nodes: graph.nodes.map((n) => (n.id === id && n.type === "grid" ? change(n) : n)),
  }), opts);
}

export const gridOps = {
  text: (id, r, c, text) => editGrid(id, (n) => setCellText(n, r, c, text)),
  fill: (id, range, fill) => editGrid(id, (n) => setRangeStyle(n, range, { fill })),
  color: (id, range, color) => editGrid(id, (n) => setRangeStyle(n, range, { color })),
  merge: (id, range) => editGrid(id, (n) => mergeRange(n, range)),
  unmerge: (id, range) => editGrid(id, (n) => unmergeRange(n, range)),
  addRow: (id, at) => editGrid(id, (n) => insertRow(n, at)),
  addColumn: (id, at) => editGrid(id, (n) => insertColumn(n, at)),
  removeRow: (id, at) => editGrid(id, (n) => removeRow(n, at)),
  removeColumn: (id, at) => editGrid(id, (n) => removeColumn(n, at)),
};

export { GRID_FILLS };

/** Adds an empty grid at the middle of the view and selects it. */
export function addEmptyGrid(rows = 4, cols = 4) {
  const store = useCanvasStore.getState();
  const node = createGrid(rows, cols, store.viewportCenter());
  store.addNode(node);
  return node;
}

/** Adds a grid from pasted CSV or TSV text at the middle of the view; false when the text holds no table. */
export function addGridFromText(text) {
  const store = useCanvasStore.getState();
  const node = gridFromDelimited(text, store.viewportCenter());
  if (!node) return false;
  store.addNode(node);
  return true;
}
