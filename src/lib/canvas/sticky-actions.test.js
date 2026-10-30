import assert from "node:assert/strict";
import test from "node:test";
import { useCanvasStore } from "../canvas-store.js";
import { useStore } from "../store.js";
import { emptyCanvasState } from "./serialization.js";
import {
  addBulkStickies,
  addStickyStack,
  addTagToSelection,
  clusterSelection,
  copySelectionStyle,
  pasteCellsAsStickies,
  pasteSelectionStyle,
  removeTag,
  selectByTag,
  setReactionOnSelection,
  setSelectedStickyFlag,
  setSelectedStickyShape,
  switchSelectionType,
  takeStickyFromStack,
  toggleStickyReaction,
} from "./sticky-actions.js";

function withStorage(t) {
  const map = new Map();
  const value = { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k) };
  const had = Object.prototype.hasOwnProperty.call(globalThis, "localStorage");
  const prior = globalThis.localStorage;
  Object.defineProperty(globalThis, "localStorage", { value, configurable: true, writable: true });
  t.after(() => {
    if (had) Object.defineProperty(globalThis, "localStorage", { value: prior, configurable: true, writable: true });
    else delete globalThis.localStorage;
  });
}

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const sticky = (id, extra = {}) => ({ id, type: "sticky", x: 0, y: 0, w: 200, h: 200, text: id, fill: "#e3c56a", fontSize: 16,
  color: "#1c1a12", opacity: 1, parentId: null, groupId: null, ...extra });

async function openBoard(t, role, nodes) {
  withStorage(t);
  t.mock.method(globalThis, "fetch", async () => json(200, { id: "board-1", name: "Board", data: { ...emptyCanvasState(), nodes }, updatedAt: 1, role }));
  useStore.setState({ currentUser: { id: "u1" } });
  const store = useCanvasStore;
  store.getState().reset();
  await store.getState().loadBoard("board-1");
  t.after(() => {
    store.getState().reset();
    useStore.setState({ currentUser: null });
  });
  return store;
}

const nodes = () => useCanvasStore.getState().history.present.nodes;
const undoSteps = () => useCanvasStore.getState().history.past.length;

test("bulk mode and cell paste add selected auto-fitting stickies in one undo step each", async (t) => {
  const store = await openBoard(t, "edit", []);
  assert.equal(addBulkStickies("a\nb\n\nc", { x: 0, y: 0 }), 3);
  assert.equal(undoSteps(), 1);
  assert.deepEqual(nodes().map((n) => [n.text, n.autoFit]), [["a", true], ["b", true], ["c", true]]);
  assert.deepEqual(store.getState().selection, nodes().map((n) => n.id));
  const rows = Array.from({ length: 51 }, () => ["x"]);
  assert.deepEqual(pasteCellsAsStickies(rows, { x: 0, y: 0 }), { added: 50, truncated: true });
  assert.equal(undoSteps(), 2);
});

test("dragging off a stack adds a blank sticky in its color as part of the drag's undo step", async (t) => {
  const store = await openBoard(t, "edit", []);
  addStickyStack({ x: 0, y: 0 });
  const stack = nodes()[0];
  assert.equal(stack.type, "stack");
  takeStickyFromStack(stack);
  const added = nodes()[1];
  assert.deepEqual([added.type, added.text, added.fill, added.x, added.y], ["sticky", "", stack.fill, -100, -100]);
  assert.deepEqual(store.getState().selection, [added.id]);
  assert.equal(nodes().length, 2);
});

test("votes, shape, author label, tags and type switching edit stickies, including culled ones", async (t) => {
  const store = await openBoard(t, "edit", [sticky("a"), sticky("b", { x: 50000 })]);
  toggleStickyReaction("a", "👍");
  assert.deepEqual(nodes()[0].reactions, { "👍": ["u1"] });
  toggleStickyReaction("a", "👍");
  assert.equal(nodes()[0].reactions, undefined);

  store.getState().setSelection(["a", "b"]);
  setSelectedStickyShape("rectangle");
  assert.deepEqual(nodes().map((n) => n.w), [350, 350]);
  setSelectedStickyFlag("showAuthor", true);
  assert.deepEqual(nodes().map((n) => n.showAuthor), [true, true]);

  const tag = addTagToSelection("Idea");
  assert.equal(addTagToSelection(" idea ").id, tag.id);
  assert.deepEqual(store.getState().history.present.tags, [tag]);
  store.getState().setSelection([]);
  selectByTag(tag.id);
  assert.deepEqual(store.getState().selection, ["a", "b"]);
  removeTag(tag.id);
  assert.deepEqual(nodes().map((n) => n.tagIds), [undefined, undefined]);

  switchSelectionType("ellipse");
  assert.deepEqual(nodes().map((n) => [n.id, n.type, n.text]), [["a", "ellipse", "a"], ["b", "ellipse", "b"]]);
});

test("copy and paste style carry one object's style onto the selection", async (t) => {
  const store = await openBoard(t, "edit", [sticky("a", { fill: "#3a3a3a", color: "#f5f5f5", fontSize: 24, fontFamily: "caveat" }), sticky("b", { autoFit: true })]);
  store.getState().setSelection(["a"]);
  assert.equal(copySelectionStyle(), true);
  store.getState().setSelection(["b"]);
  assert.equal(pasteSelectionStyle(), true);
  assert.deepEqual([nodes()[1].fill, nodes()[1].color, nodes()[1].fontSize, nodes()[1].fontFamily, nodes()[1].autoFit],
    ["#3a3a3a", "#f5f5f5", 24, "caveat", undefined]);
});

test("pasting a text style aligns shape text but leaves a shape without text unstyled", async (t) => {
  const rect = (id, extra) => ({ id, type: "rect", x: 0, y: 0, w: 100, h: 60, fill: "#fff", stroke: "#000", strokeWidth: 1, ...extra });
  const store = await openBoard(t, "edit", [
    { id: "t", type: "text", x: 0, y: 0, w: 100, h: 32, text: "x", fontSize: 20, align: "right", color: "#123abc" },
    rect("withText", { text: "y" }),
    rect("plain"),
  ]);
  store.getState().setSelection(["t"]);
  copySelectionStyle();
  store.getState().setSelection(["withText", "plain"]);
  pasteSelectionStyle();
  const [, withText, plain] = nodes();
  assert.deepEqual([withText.align, withText.color, withText.fontSize], ["right", "#123abc", 20]);
  assert.deepEqual([plain.align, plain.color, plain.fontSize], [undefined, undefined, undefined]);
});

test("clustering lays the selection out in titled groups by color", async (t) => {
  const store = await openBoard(t, "edit", [sticky("a"), sticky("b", { fill: "#3a3a3a", x: 900 }), sticky("c", { y: 900 })]);
  store.getState().setSelection(["a", "b", "c"]);
  clusterSelection("color", (id) => id);
  const titles = nodes().filter((n) => n.type === "text").map((n) => n.text);
  assert.deepEqual(titles, ["Yellow (2)", "Charcoal (1)"]);
  assert.equal(undoSteps(), 1);
  assert.equal(store.getState().selection.length, 5);
});

for (const role of ["view", "comment"]) {
  test(`a ${role}-only board refuses every sticky action`, async (t) => {
    const store = await openBoard(t, role, [sticky("a")]);
    const before = nodes();
    store.getState().setSelection(["a"]);
    addBulkStickies("x", { x: 0, y: 0 });
    pasteCellsAsStickies([["x"]], { x: 0, y: 0 });
    addStickyStack({ x: 0, y: 0 });
    toggleStickyReaction("a", "👍");
    setSelectedStickyShape("rectangle");
    addTagToSelection("Idea");
    switchSelectionType("text");
    clusterSelection("color", (id) => id);
    copySelectionStyle();
    pasteSelectionStyle();
    assert.deepEqual(nodes(), before);
    assert.equal(store.getState().history.present.tags, undefined);
    assert.equal(undoSteps(), 0);
  });
}

test("a vote from the picker goes on every selected sticky, and comes off all of them", async (t) => {
  const store = await openBoard(t, "edit", [sticky("a", { reactions: { "🔥": ["u1"] } }), sticky("b"), { ...sticky("c"), type: "text" }]);
  store.getState().setSelection(["a", "b", "c"]);
  setReactionOnSelection("🔥", true);
  assert.deepEqual(nodes().map((n) => n.reactions), [{ "🔥": ["u1"] }, { "🔥": ["u1"] }, undefined]);
  setReactionOnSelection("🔥", false);
  assert.deepEqual(nodes().map((n) => n.reactions), [undefined, undefined, undefined]);
  assert.equal(undoSteps(), 2);
});
