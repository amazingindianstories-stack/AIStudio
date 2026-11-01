import assert from "node:assert/strict";
import test from "node:test";
import { useCanvasStore } from "./canvas-store.js";
import { emptyCanvasState, validateCanvasState } from "./canvas/serialization.js";
import { nodeCorners } from "./canvas/geometry.js";

const base = { opacity: 1, parentId: null, groupId: null, fill: "#fff", stroke: "#000", strokeWidth: 2 };
const a = { ...base, id: "a", type: "rect", x: 0, y: 0, w: 100, h: 100 };
const b = { ...base, id: "b", type: "rect", x: 200, y: 0, w: 100, h: 100 };
const locked = { ...base, id: "l", type: "rect", x: 0, y: 300, w: 100, h: 100, locked: true };
const frame = { id: "f", type: "frame", x: 600, y: 0, w: 300, h: 300, name: "Frame", fill: "transparent", stroke: "#000", parentId: null, groupId: null };
const image = { id: "i", type: "image", x: 0, y: 600, w: 200, h: 100, src: "/api/media/x.png", opacity: 1, parentId: null, groupId: null, aspectLocked: true };

const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

async function board(t, role = "edit") {
  t.mock.method(globalThis, "fetch", async (url, init = {}) =>
    (init.method || "GET") === "PUT"
      ? json({ ok: true, updatedAt: Date.now() })
      : json({ id: "board-1", name: "Board", data: { ...emptyCanvasState(), nodes: [a, b, locked, frame, image] }, updatedAt: 1, role }));
  const store = useCanvasStore;
  store.getState().reset();
  await store.getState().loadBoard("board-1");
  t.after(() => store.getState().reset());
  return store;
}

const nodeOf = (store, id) => store.getState().history.present.nodes.find((n) => n.id === id);

test("rotateSelectionBy turns the group about its center as one undo step, skipping locked nodes and frames", async (t) => {
  const store = await board(t);
  store.getState().setSelection(["a", "b", "l", "f"]);
  store.getState().rotateSelectionBy(90);
  // The rotatable pair's box is centered at (150, 50).
  assert.equal(nodeOf(store, "a").rotation, 90);
  assert.equal(nodeOf(store, "b").rotation, 90);
  assert.ok(Math.abs(nodeOf(store, "a").x - 100) < 1e-6 && Math.abs(nodeOf(store, "a").y + 100) < 1e-6);
  assert.equal(nodeOf(store, "l").rotation, undefined);
  assert.equal(nodeOf(store, "f").rotation, undefined);
  assert.equal(store.getState().history.past.length, 1);
  assert.equal(store.getState().saveStatus, "dirty");
  // The rotation survives the board format.
  assert.equal(validateCanvasState(store.getState().history.present).nodes.find((n) => n.id === "a").rotation, 90);
  store.getState().undo();
  assert.deepEqual(nodeOf(store, "a"), a);
});

test("setRotation sets the angle about each object's center; a whole turn removes it", async (t) => {
  const store = await board(t);
  store.getState().setSelection(["a"]);
  store.getState().setRotation(-30);
  assert.equal(nodeOf(store, "a").rotation, 330);
  assert.equal(nodeOf(store, "a").x, 0);
  store.getState().setRotation(0);
  assert.equal("rotation" in nodeOf(store, "a"), false);
  assert.equal(store.getState().history.past.length, 2);
  // Nothing to change adds no history.
  store.getState().setRotation(360);
  store.getState().setRotation(45, ["l", "f"]);
  assert.equal(store.getState().history.past.length, 2);
});

test("setSize sets whole-pixel sizes on every selected unlocked object and honors the image aspect lock", async (t) => {
  const store = await board(t);
  store.getState().setSelection(["a", "b", "l", "i"]);
  store.getState().setSize({ w: 150.4 });
  assert.deepEqual(["a", "b", "l", "i"].map((id) => [nodeOf(store, id).w, nodeOf(store, id).h]), [
    [150, 100],
    [150, 100],
    [100, 100],
    [150, 75],
  ]);
  assert.equal(store.getState().history.past.length, 1);
  store.getState().setAspectLocked(false, ["i"]);
  store.getState().setSize({ h: 2 }, ["i"]);
  assert.deepEqual([nodeOf(store, "i").w, nodeOf(store, "i").h], [150, 4]);
});

test("setSize on a rotated object keeps its top-left corner in place", async (t) => {
  const store = await board(t);
  store.getState().setRotation(40, ["a"]);
  const before = nodeCorners(nodeOf(store, "a"))[0];
  store.getState().setSize({ w: 260, h: 80 }, ["a"]);
  const after = nodeCorners(nodeOf(store, "a"))[0];
  assert.ok(Math.abs(before.x - after.x) < 1e-6 && Math.abs(before.y - after.y) < 1e-6);
});

test("a rotated text box that grows while edited keeps its top-left corner", async (t) => {
  const store = await board(t);
  const text = { id: "t", type: "text", x: 0, y: 0, w: 200, h: 32, text: "", fontSize: 16, align: "left", color: "#fff", opacity: 1, parentId: null, groupId: null, rotation: 90 };
  store.getState().addNode(text);
  const before = nodeCorners(nodeOf(store, "t"))[0];
  store.getState().commitNodeText("t", "a\nb\nc", [], 80);
  const grown = nodeOf(store, "t");
  assert.equal(grown.h, 80);
  const after = nodeCorners(grown)[0];
  assert.ok(Math.abs(before.x - after.x) < 1e-6 && Math.abs(before.y - after.y) < 1e-6);
});

test("viewers cannot rotate or resize", async (t) => {
  const store = await board(t, "view");
  store.getState().setSelection(["a"]);
  store.getState().rotateSelectionBy(45);
  store.getState().setRotation(10);
  store.getState().setSize({ w: 300 });
  store.getState().setAspectLocked(false, ["i"]);
  assert.deepEqual(nodeOf(store, "a"), a);
  assert.deepEqual(nodeOf(store, "i"), image);
  assert.equal(store.getState().history.past.length, 0);
});
