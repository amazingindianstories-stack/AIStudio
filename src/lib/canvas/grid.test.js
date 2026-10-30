import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_GRID_CELLS, cellAt, createGrid, expandToMerges, gridFromDelimited, insertColumn, insertRow, mergeRange, parseDelimited,
  removeColumn, removeRow, setCellText, setRangeStyle, unmergeRange, visibleCells,
} from "./grid.js";

const grid = (rows = 3, cols = 3) => createGrid(rows, cols, { x: 0, y: 0 }, "g");

test("a new grid is centered and sized by its cells", () => {
  const g = grid(2, 4);
  assert.deepEqual([g.rows, g.cols, g.w, g.h, g.x, g.y], [2, 4, 480, 96, -240, -48]);
});

test("a grid never exceeds 2,500 cells", () => {
  const g = createGrid(100, 100, { x: 0, y: 0 });
  assert.ok(g.rows * g.cols <= MAX_GRID_CELLS);
  const full = { ...grid(50, 50) };
  assert.equal(insertRow(full, 0), full);
  assert.equal(insertColumn(full, 0), full);
});

test("cell text and colors are stored sparsely", () => {
  let g = setCellText(grid(), 1, 2, "hello");
  g = setRangeStyle(g, { r0: 0, c0: 0, r1: 1, c1: 1 }, { fill: "#ffffff" });
  assert.equal(cellAt(g, 1, 2).text, "hello");
  assert.equal(cellAt(g, 0, 0).fill, "#ffffff");
  assert.equal(g.cells.length, 5);
  assert.deepEqual(g.cells.find(([r, c]) => r === 1 && c === 2), [1, 2, "hello"]);
  const cleared = setRangeStyle(setCellText(g, 1, 2, ""), { r0: 0, c0: 0, r1: 1, c1: 1 }, { fill: null });
  assert.equal(cleared.cells.length, 0);
  assert.equal(setCellText(g, 9, 9, "x"), g, "outside the table is ignored");
});

test("merged cells join text and hide covered cells", () => {
  let g = setCellText(setCellText(grid(), 0, 0, "a"), 0, 1, "b");
  g = mergeRange(g, { r0: 0, c0: 0, r1: 1, c1: 1 });
  assert.deepEqual(g.merges, [[0, 0, 2, 2]]);
  assert.equal(cellAt(g, 0, 0).text, "a b");
  const cells = visibleCells(g);
  assert.equal(cells.length, 9 - 3);
  assert.deepEqual(cells[0], { r: 0, c: 0, rs: 2, cs: 2, text: "a b", fill: null, color: null });
  const split = unmergeRange(g, { r0: 0, c0: 0, r1: 0, c1: 0 });
  assert.deepEqual(split.merges, []);
  assert.equal(visibleCells(split).length, 9);
});

test("merging a range that overlaps a merge takes the whole merge", () => {
  const g = mergeRange(grid(4, 4), { r0: 0, c0: 0, r1: 1, c1: 1 });
  assert.deepEqual(expandToMerges(g, { r0: 1, c0: 1, r1: 2, c1: 2 }), { r0: 0, c0: 0, r1: 2, c1: 2 });
  assert.deepEqual(mergeRange(g, { r0: 1, c0: 1, r1: 2, c1: 2 }).merges, [[0, 0, 3, 3]]);
  assert.equal(mergeRange(grid(), { r0: 1, c0: 1, r1: 1, c1: 1 }).merges.length, 0);
});

test("rows and columns insert and remove, shifting cells and merges", () => {
  let g = setCellText(grid(), 2, 2, "corner");
  g = mergeRange(g, { r0: 0, c0: 0, r1: 1, c1: 1 });
  const taller = insertRow(g, 1);
  assert.equal(taller.rows, 4);
  assert.equal(taller.h, g.h + g.h / 3);
  assert.deepEqual(taller.merges, [[0, 0, 3, 2]], "inserting inside a merge extends it");
  assert.equal(cellAt(taller, 3, 2).text, "corner");
  const wider = insertColumn(g, 3);
  assert.equal(wider.cols, 4);
  const shorter = removeRow(taller, 1);
  assert.deepEqual(shorter.merges, [[0, 0, 2, 2]]);
  assert.equal(cellAt(removeRow(g, 0), 1, 2).text, "corner");
  assert.deepEqual(removeColumn(g, 0).merges, [[0, 0, 2, 1]]);
  assert.deepEqual(removeColumn(removeColumn(g, 0), 0).merges, [], "removing the last column of a merge drops the merge");
  assert.equal(removeRow(grid(1, 2), 0).rows, 1, "the last row stays");
});

test("pasted CSV and TSV become cells, quotes and all", () => {
  assert.deepEqual(parseDelimited("a,b\nc,d"), [["a", "b"], ["c", "d"]]);
  assert.deepEqual(parseDelimited("a\tb\r\n1\t2\r\n"), [["a", "b"], ["1", "2"]]);
  assert.deepEqual(parseDelimited('"x, y","say ""hi"""\n1,2'), [["x, y", 'say "hi"'], ["1", "2"]]);
  assert.deepEqual(parseDelimited('"multi\nline",z'), [["multi\nline", "z"]]);
  assert.deepEqual(parseDelimited("   "), []);
  const g = gridFromDelimited("name,qty\nbolt,4\nnut", { x: 0, y: 0 }, "g");
  assert.deepEqual([g.rows, g.cols], [3, 2]);
  assert.equal(cellAt(g, 1, 0).text, "bolt");
  assert.equal(cellAt(g, 2, 1).text, "");
  assert.equal(gridFromDelimited("", { x: 0, y: 0 }), null);
});

test("a huge paste is trimmed to the cell cap", () => {
  const text = Array.from({ length: 300 }, (_, r) => Array.from({ length: 30 }, (_, c) => `${r}-${c}`).join(",")).join("\n");
  const g = gridFromDelimited(text, { x: 0, y: 0 });
  assert.ok(g.rows * g.cols <= MAX_GRID_CELLS);
});
