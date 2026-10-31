import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateCanvasState } from "../serialization.js";
import {
  acceptSuggestion,
  addSuggestion,
  addTableColumn,
  addTableRow,
  applyBlockShortcut,
  boardStatus,
  dateChip,
  defaultViewPatches,
  docToMarkdown,
  formatContent,
  insertBlockAfter,
  moveBlock,
  newBlock,
  newFormatNode,
  parseChips,
  plainText,
  rejectSuggestion,
  removeBlock,
  userChip,
} from "./model.js";

const fixture = JSON.parse(readFileSync(new URL("../../../../backend/apps/canvas/fixtures/format_v1_formats.json", import.meta.url)));

test("shared fixture cases validate to the recorded boards", () => {
  for (const [name, c] of Object.entries(fixture.cases)) {
    assert.deepEqual(validateCanvasState(structuredClone(c.input)), c.expected, name);
  }
});

test("validated format boards are stable under a second pass", () => {
  for (const [name, c] of Object.entries(fixture.cases)) {
    assert.deepEqual(validateCanvasState(JSON.parse(JSON.stringify(c.expected))), c.expected, name);
  }
});

test("new format nodes pass validation unchanged", () => {
  for (const kind of ["doc", "deck", "html", "drawio"]) {
    const node = newFormatNode(kind, { x: 0, y: 0 });
    const state = validateCanvasState({ nodes: [node] });
    assert.equal(state.nodes.length, 1, kind);
    assert.equal(state.nodes[0].format, kind);
  }
});

test("typing shortcuts turn a paragraph into a heading, list or checklist", () => {
  const p = newBlock("p");
  assert.deepEqual(applyBlockShortcut(p, "## Plan"), { type: "h2", text: "Plan" });
  assert.deepEqual(applyBlockShortcut(p, "- item"), { type: "ul", text: "item" });
  assert.deepEqual(applyBlockShortcut(p, "[] todo"), { type: "todo", text: "todo" });
  assert.deepEqual(applyBlockShortcut(p, "plain"), { type: "p", text: "plain" });
  assert.equal(applyBlockShortcut(newBlock("h1"), "# keep").type, "h1");
});

test("blocks insert, move and remove, keeping at least one block", () => {
  const a = newBlock("p", "a");
  const b = newBlock("p", "b");
  const c = newBlock("p", "c");
  let blocks = insertBlockAfter([a, c], a.id, b);
  assert.deepEqual(blocks.map((x) => x.text), ["a", "b", "c"]);
  blocks = moveBlock(blocks, c.id, -1);
  assert.deepEqual(blocks.map((x) => x.text), ["a", "c", "b"]);
  assert.equal(moveBlock(blocks, a.id, -1), blocks);
  assert.equal(removeBlock([a], a.id).length, 1);
});

test("tables grow and stay within limits", () => {
  let rows = [["a", "b"], ["c", "d"]];
  rows = addTableRow(rows);
  rows = addTableColumn(rows);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].length, 3);
  for (let i = 0; i < 30; i += 1) rows = addTableRow(rows);
  assert.equal(rows.length, 20);
});

test("user and date chips parse out of text", () => {
  const text = `Ask ${userChip("Ada Lovelace", "u1")} by ${dateChip("2026-11-02")}.`;
  const parts = parseChips(text);
  assert.deepEqual(parts.map((p) => p.kind), ["text", "user", "text", "date", "text"]);
  assert.equal(parts[1].id, "u1");
  assert.equal(plainText(text), "Ask @Ada Lovelace by 2026-11-02.");
  assert.equal(parseChips("{{date:2026-13-45}}")[0].kind, "text");
});

test("accepting a suggestion applies it and rejecting leaves the text", () => {
  const a = newBlock("p", "old");
  const b = newBlock("p", "keep");
  let s = addSuggestion([], { blockId: a.id, kind: "replace", text: "new", by: "u" });
  s = addSuggestion(s, { blockId: b.id, kind: "delete", by: "u" });
  s = addSuggestion(s, { blockId: a.id, kind: "insert", text: "after", by: "u" });
  assert.equal(s.length, 3);
  const rejected = rejectSuggestion(s, s[0].id);
  assert.equal(rejected.length, 2);
  let state = acceptSuggestion([a, b], s, s[0].id);
  assert.equal(state.blocks[0].text, "new");
  state = acceptSuggestion(state.blocks, state.suggestions, s[2].id);
  assert.deepEqual(state.blocks.map((x) => x.text), ["new", "after", "keep"]);
  state = acceptSuggestion(state.blocks, state.suggestions, s[1].id);
  assert.deepEqual(state.blocks.map((x) => x.text), ["new", "after"]);
  assert.equal(state.suggestions.length, 0);
});

test("a person's newer suggestion on the same block replaces their older one", () => {
  const s1 = addSuggestion([], { blockId: "b", kind: "replace", text: "one", by: "u" });
  const s2 = addSuggestion(s1, { blockId: "b", kind: "replace", text: "two", by: "u" });
  assert.equal(s2.length, 1);
  assert.equal(s2[0].text, "two");
});

test("board status follows the default view, else the least finished format", () => {
  const doc = { ...newFormatNode("doc", { x: 0, y: 0 }), status: "approved" };
  const deck = { ...newFormatNode("deck", { x: 0, y: 0 }), status: "draft" };
  assert.equal(boardStatus([doc, deck]), "draft");
  assert.equal(boardStatus([{ ...doc, defaultView: true }, deck]), "approved");
  assert.equal(boardStatus([newFormatNode("html", { x: 0, y: 0 })]), null);
});

test("choosing a default view clears the previous one and a lock rides along", () => {
  const a = { ...newFormatNode("doc", { x: 0, y: 0 }), defaultView: true };
  const b = newFormatNode("deck", { x: 0, y: 0 });
  const patches = defaultViewPatches([a, b], b.id, { on: true, locked: true });
  assert.equal(patches.length, 2);
  assert.deepEqual(patches.find((p) => p.id === b.id).patch, { defaultView: true, viewLocked: true });
  assert.equal(patches.find((p) => p.id === a.id).patch.defaultView, undefined);
});

test("doc markdown export and the shared content contract", () => {
  const doc = newFormatNode("doc", { x: 0, y: 0 });
  doc.blocks = [
    { id: "1", type: "h1", text: "T" },
    { id: "2", type: "todo", text: "x", checked: true },
    { id: "3", type: "table", rows: [["a", "b"], ["1", "2"]] },
  ];
  const md = docToMarkdown(doc);
  assert.match(md, /# T/);
  assert.match(md, /- \[x\] x/);
  assert.match(md, /\| a \| b \|/);
  assert.deepEqual(Object.keys(formatContent(doc)).sort(), ["blocks", "id", "kind", "name"]);
  assert.equal(formatContent({ type: "rect" }), null);
});
