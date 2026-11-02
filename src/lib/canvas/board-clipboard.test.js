import { test } from "node:test";
import assert from "node:assert/strict";
import { BOARD_COPY_ATTRIBUTE, boardClipboardData, clipboardCells, isBoardCopy } from "./board-clipboard";

// A tiny stand-in for DOMParser: enough of a table for clipboardCells.
function fakeParseHtml(html) {
  const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map(([, row]) => ({
    querySelectorAll: () =>
      [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(([, cell]) => ({ textContent: cell.replace(/<[^>]+>/g, "") })),
  }));
  return { querySelector: () => (/<table/i.test(html) ? { querySelectorAll: () => rows } : null) };
}

const at = (id, x, y, fields) => ({ id, x, y, w: 100, h: 100, ...fields });

test("a board copy puts its text and the board marker on the clipboard", () => {
  const data = boardClipboardData([at("frame", 0, 200, { type: "frame", name: "Frame" }), at("img", 200, 0, { type: "image" }), at("one", 0, 0, { type: "sticky", text: "One <b>" })]);
  assert.equal(data["text/plain"], "One <b>\nFrame");
  assert.equal(data["text/html"], `<div ${BOARD_COPY_ATTRIBUTE}="">One &lt;b&gt;<br>Frame</div>`);
  assert.ok(isBoardCopy(data["text/html"]));
  assert.ok(!isBoardCopy("<table><tr><td>a</td></tr></table>"));
  assert.ok(!isBoardCopy(""));
});

test("a copied frame's text is followed by its contents on the board", () => {
  const frame = at("frame", 0, 0, { type: "frame", name: "Plan", w: 400, h: 400 });
  const present = { nodes: [frame, at("b", 200, 50, { type: "sticky", text: "Second", parentId: "frame" }), at("a", 20, 50, { type: "sticky", text: "First", parentId: "frame" }), at("out", 900, 0, { type: "sticky", text: "Elsewhere" })] };
  assert.equal(boardClipboardData([frame], present)["text/plain"], "Plan\nFirst\nSecond");
  // A cut frame's contents left with it: only what was copied is written.
  assert.equal(boardClipboardData([frame])["text/plain"], "Plan");
});

test("spreadsheet cells come from an HTML table, keeping line breaks inside a cell", () => {
  const html = "<table><tr><td>a</td><td>b<br>c</td></tr><tr><th> d </th><td></td></tr></table>";
  assert.deepEqual(clipboardCells(html, "ignored", fakeParseHtml), [["a", "b\nc"], ["d", ""]]);
});

test("without a table the cells come from tab-separated text", () => {
  assert.deepEqual(clipboardCells("", "a\tb\nc\td", fakeParseHtml), [["a", "b"], ["c", "d"]]);
  // Plain text without a tab is not a block of cells.
  assert.equal(clipboardCells("<p>x</p>", "one", fakeParseHtml), null);
  assert.equal(clipboardCells("", "", fakeParseHtml), null);
});

test("an empty table or a board copy falls back to the text", () => {
  assert.deepEqual(clipboardCells("<table><tr><td> </td></tr></table>", "x\ty", fakeParseHtml), [["x", "y"]]);
  const board = { "text/html": `<table ${BOARD_COPY_ATTRIBUTE}=""><tr><td>a</td></tr></table>` };
  assert.deepEqual(clipboardCells(board["text/html"], "p\tq", fakeParseHtml), [["p", "q"]]);
});
