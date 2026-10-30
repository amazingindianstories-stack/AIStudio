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

test("a board copy puts its text and the board marker on the clipboard", () => {
  const data = boardClipboardData([{ text: "One <b>" }, { type: "image" }, { name: "Frame" }]);
  assert.equal(data["text/plain"], "One <b>\nFrame");
  assert.equal(data["text/html"], `<div ${BOARD_COPY_ATTRIBUTE}="">One &lt;b&gt;<br>Frame</div>`);
  assert.ok(isBoardCopy(data["text/html"]));
  assert.ok(!isBoardCopy("<table><tr><td>a</td></tr></table>"));
  assert.ok(!isBoardCopy(""));
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
