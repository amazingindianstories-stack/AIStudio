import assert from "node:assert/strict";
import test from "node:test";
import { useCanvasStore } from "./canvas-store.js";
import { emptyCanvasState } from "./canvas/serialization.js";
import { frameSelection, setFrameHidden, setFramePreset } from "./frame-actions.js";

const base = { parentId: null, groupId: null };
const sticky = (id, x, y) => ({ id, type: "sticky", x, y, w: 100, h: 100, text: id, fill: "#fde68a", fontSize: 16, color: "#111", opacity: 1, ...base });
const frame = (id, x, y, w, h, name = "Frame") => ({ id, type: "frame", x, y, w, h, name, fill: "transparent", stroke: "#000", ...base });

const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

async function board(t, nodes) {
  t.mock.method(globalThis, "fetch", async (url, init = {}) =>
    (init.method || "GET") === "PUT"
      ? json({ ok: true, updatedAt: Date.now() })
      : json({ id: "board-1", name: "Board", data: { ...emptyCanvasState(), nodes }, updatedAt: 1, role: "edit" }));
  useCanvasStore.getState().reset();
  await useCanvasStore.getState().loadBoard("board-1");
  t.after(() => useCanvasStore.getState().reset());
  return useCanvasStore;
}

const get = (store, id) => store.getState().history.present.nodes.find((n) => n.id === id);

test("create frame around selection wraps the objects in one undo step and selects the frame", async (t) => {
  const store = await board(t, [sticky("a", 0, 0), sticky("b", 300, 100)]);
  store.getState().setSelection(["a", "b"]);
  assert.equal(frameSelection(), true);
  const [id] = store.getState().selection;
  const made = get(store, id);
  assert.equal(made.type, "frame");
  assert.equal(get(store, "a").parentId, id);
  assert.equal(get(store, "b").parentId, id);
  assert.ok(made.x <= 0 && made.y <= 0 && made.x + made.w >= 400 && made.y + made.h >= 200);
  assert.equal(store.getState().history.past.length, 1);
  store.getState().undo();
  assert.equal(get(store, "a").parentId, null);
});

test("frameSelection does nothing without a selection", async (t) => {
  const store = await board(t, [sticky("a", 0, 0)]);
  assert.equal(frameSelection(), false);
  assert.equal(store.getState().history.past.length, 0);
});

test("a frame takes a size preset and can be hidden and revealed", async (t) => {
  const store = await board(t, [frame("f", 10, 20, 300, 300)]);
  setFramePreset("f", { id: "slide-16-9", w: 1280, h: 720 });
  assert.deepEqual([get(store, "f").x, get(store, "f").y, get(store, "f").w, get(store, "f").h], [10, 20, 1280, 720]);
  setFrameHidden("f", true);
  assert.equal(get(store, "f").hidden, true);
  setFrameHidden("f", false);
  assert.equal("hidden" in get(store, "f"), false);
});

test("moving a frame carries nested frames and their contents", async (t) => {
  const store = await board(t, [
    frame("outer", 0, 0, 800, 600, "Outer"),
    { ...frame("inner", 50, 50, 300, 300, "Inner"), parentId: "outer" },
    { ...sticky("s", 60, 60), parentId: "inner" },
  ]);
  store.getState().setSelection(["outer"]);
  store.getState().moveSelectionBy(100, 40);
  assert.deepEqual([get(store, "inner").x, get(store, "inner").y], [150, 90]);
  assert.deepEqual([get(store, "s").x, get(store, "s").y], [160, 100]);
});

test("pasting a copy into a frame places it at the same offset and nests it", async (t) => {
  const store = await board(t, [frame("f1", 0, 0, 400, 400), frame("f2", 1000, 0, 400, 400), { ...sticky("s", 50, 60), parentId: "f1" }]);
  store.getState().setSelection(["s"]);
  store.getState().copy();
  store.getState().setSelection(["f2"]);
  store.getState().paste();
  const copy = store.getState().history.present.nodes.find((n) => n.type === "sticky" && n.id !== "s");
  assert.equal(copy.parentId, "f2");
  assert.deepEqual([copy.x, copy.y], [1050, 60]);
});

test("viewers cannot create frames", async (t) => {
  t.mock.method(globalThis, "fetch", async () => json({ id: "board-1", name: "B", data: { ...emptyCanvasState(), nodes: [sticky("a", 0, 0)] }, updatedAt: 1, role: "read" }));
  useCanvasStore.getState().reset();
  await useCanvasStore.getState().loadBoard("board-1");
  t.after(() => useCanvasStore.getState().reset());
  useCanvasStore.getState().setSelection(["a"]);
  assert.equal(frameSelection(), false);
});
