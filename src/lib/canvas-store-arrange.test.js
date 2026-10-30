import assert from "node:assert/strict";
import test from "node:test";
import { useCanvasStore } from "./canvas-store.js";
import { emptyCanvasState } from "./canvas/serialization.js";

const base = { opacity: 1, parentId: null, groupId: null, fill: "#fff", stroke: "#000", strokeWidth: 2 };
const a = { ...base, id: "a", type: "rect", x: 0, y: 0, w: 100, h: 100, text: "A", marks: [[0, 1, "b"]] };
const b = { ...base, id: "b", type: "rect", x: 150, y: 40, w: 50, h: 50 };
const c = { ...base, id: "c", type: "rect", x: 400, y: 10, w: 100, h: 100 };
const locked = { ...base, id: "l", type: "rect", x: -300, y: 500, w: 100, h: 100, locked: true, text: "keep" };
const sticky = { id: "s", type: "sticky", x: 0, y: 300, w: 120, h: 120, text: "Note", fill: "#fde68a", fontSize: 16, color: "#111", opacity: 1, parentId: null, groupId: null };
const image = { id: "i", type: "image", x: 600, y: 600, w: 200, h: 100, src: "/api/media/x.png", opacity: 1, parentId: null, groupId: null };

const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

async function board(t, role = "edit") {
  t.mock.method(globalThis, "fetch", async (url, init = {}) =>
    (init.method || "GET") === "PUT"
      ? json({ ok: true, updatedAt: Date.now() })
      : json({ id: "board-1", name: "Board", data: { ...emptyCanvasState(), nodes: [a, b, c, locked, sticky, image] }, updatedAt: 1, role }));
  const store = useCanvasStore;
  store.getState().reset();
  await store.getState().loadBoard("board-1");
  t.after(() => store.getState().reset());
  return store;
}

const nodeOf = (store, id) => store.getState().history.present.nodes.find((n) => n.id === id);
const pastLength = (store) => store.getState().history.past.length;

test("align moves the selection in one undo step and leaves locked objects alone", async (t) => {
  const store = await board(t);
  store.getState().setSelection(["a", "b", "l"]);
  store.getState().alignSelection("top");
  assert.equal(nodeOf(store, "b").y, 0);
  assert.equal(nodeOf(store, "a").y, 0);
  assert.equal(nodeOf(store, "l").y, 500);
  assert.equal(pastLength(store), 1);
  assert.equal(store.getState().saveStatus, "dirty");
  store.getState().undo();
  assert.equal(nodeOf(store, "b").y, 40);
  // Already aligned: no history entry.
  store.getState().setSelection(["a", "c"]);
  store.getState().alignSelection("left");
  store.getState().setSelection(["a", "l"]);
  store.getState().alignSelection("left");
  assert.equal(nodeOf(store, "l").x, -300);
  assert.equal(pastLength(store), 1);
});

test("distribute and auto layout are single undo steps", async (t) => {
  const store = await board(t);
  store.getState().setSelection(["a", "b", "c"]);
  store.getState().distributeSelection("x");
  // Span 0..500, sizes 250: gap 125, b at 225.
  assert.equal(nodeOf(store, "b").x, 225);
  assert.equal(pastLength(store), 1);
  store.getState().autoLayoutSelection("x", 10);
  assert.deepEqual(["a", "b", "c"].map((id) => [nodeOf(store, id).x, nodeOf(store, id).y]), [[0, 0], [110, 0], [170, 0]]);
  assert.equal(pastLength(store), 2);
  store.getState().undo();
  assert.equal(nodeOf(store, "c").x, 400);
});

test("smart duplicate copies the selection beside itself and selects the copies", async (t) => {
  const store = await board(t);
  store.getState().setSelection(["a", "b"]);
  store.getState().duplicateSelectionToward("right");
  const state = store.getState();
  assert.equal(state.history.present.nodes.length, 8);
  assert.equal(state.selection.length, 2);
  assert.ok(!state.selection.includes("a") && !state.selection.includes("b"));
  const copies = state.selection.map((id) => nodeOf(store, id));
  // Selection box 0..200 wide: copies shift by 200 + 20.
  assert.deepEqual(copies.map((n) => n.x).sort((x, y) => x - y), [220, 370]);
  assert.equal(pastLength(store), 1);
  store.getState().setSelection(["s"]);
  store.getState().duplicateSelectionToward("up");
  assert.equal(nodeOf(store, store.getState().selection[0]).y, 300 - 140);
});

test("filter narrows the selection to one kind", async (t) => {
  const store = await board(t);
  store.getState().setSelection(["a", "s", "i", "b"]);
  store.getState().filterSelectionByKind("shape");
  assert.deepEqual(store.getState().selection, ["a", "b"]);
  store.getState().filterSelectionByKind("frame");
  assert.deepEqual(store.getState().selection, ["a", "b"]);
  assert.equal(pastLength(store), 0);
});

test("clear content empties unlocked text in one undo step and keeps style", async (t) => {
  const store = await board(t);
  store.getState().setSelection(["a", "s", "l", "i"]);
  store.getState().clearSelectedContent();
  assert.equal(nodeOf(store, "a").text, "");
  assert.equal("marks" in nodeOf(store, "a"), false);
  assert.equal(nodeOf(store, "s").text, "");
  assert.equal(nodeOf(store, "s").fill, "#fde68a");
  assert.equal(nodeOf(store, "l").text, "keep");
  assert.equal(pastLength(store), 1);
  // Nothing left to clear adds no history.
  store.getState().clearSelectedContent();
  assert.equal(pastLength(store), 1);
  store.getState().undo();
  assert.equal(nodeOf(store, "s").text, "Note");
});

test("arrange edits do nothing on a view-only board", async (t) => {
  const store = await board(t, "view");
  store.getState().setSelection(["a", "b", "c", "s"]);
  const before = store.getState().history.present;
  store.getState().alignSelection("left");
  store.getState().distributeSelection("x");
  store.getState().autoLayoutSelection("y", 0);
  store.getState().duplicateSelectionToward("down");
  store.getState().clearSelectedContent();
  assert.equal(store.getState().history.present, before);
  assert.equal(pastLength(store), 0);
  // Narrowing a selection is not an edit.
  store.getState().filterSelectionByKind("sticky");
  assert.deepEqual(store.getState().selection, ["s"]);
});
