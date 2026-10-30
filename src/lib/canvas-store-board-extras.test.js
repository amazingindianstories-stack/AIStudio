import assert from "node:assert/strict";
import test from "node:test";
import { useCanvasStore } from "./canvas-store.js";
import { emptyCanvasState } from "./canvas/serialization.js";
import { findOnBoard, replaceMatches } from "./canvas/find.js";
import { commandMatches } from "../components/canvas/CommandPalette.jsx";
import { slideViewport } from "../components/canvas/BoardPresentation.jsx";

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
const sticky = (id, x, text) => ({ id, type: "sticky", x, y: 0, w: 100, h: 100, text, fill: "#fde68a", fontSize: 16, color: "#111", opacity: 1, parentId: null, groupId: null });

async function loadAs(t, role) {
  withStorage(t);
  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    if ((init.method || "GET") !== "GET") return json(200, { ok: true, updatedAt: Date.now() });
    return json(200, { id: "board-1", name: "Board", data: { ...emptyCanvasState(), nodes: [sticky("a", 0, "cat"), sticky("b", 200, "cat cat")] }, updatedAt: 1, role });
  });
  const store = useCanvasStore;
  store.getState().reset();
  await store.getState().loadBoard("board-1");
  t.after(() => store.getState().reset());
  return store;
}

test("replace all is one undo step", async (t) => {
  const store = await loadAs(t, "edit");
  const present = store.getState().history.present;
  store.getState().replaceNodes(replaceMatches(present, findOnBoard(present, "cat"), "dog"));
  assert.deepEqual(store.getState().history.present.nodes.map((n) => n.text), ["dog", "dog dog"]);
  assert.equal(store.getState().history.past.length, 1);
  store.getState().undo();
  assert.deepEqual(store.getState().history.present.nodes.map((n) => n.text), ["cat", "cat cat"]);
  store.getState().replaceNodes(new Map());
  assert.equal(store.getState().history.past.length, 0);
});

test("connecting selected objects adds arrows in one undo step and selects them", async (t) => {
  const store = await loadAs(t, "edit");
  store.getState().connectNodes([["a", "b"]]);
  const { connectors } = store.getState().history.present;
  assert.equal(connectors.length, 1);
  assert.deepEqual([connectors[0].from, connectors[0].to, connectors[0].kind], [{ nodeId: "a", anchor: "auto" }, { nodeId: "b", anchor: "auto" }, "arrow"]);
  assert.deepEqual(store.getState().selectedConnectorIds, [connectors[0].id]);
  store.getState().undo();
  assert.equal(store.getState().history.present.connectors.length, 0);
});

test("viewers cannot replace, connect or reorder", async (t) => {
  const store = await loadAs(t, "view");
  const present = store.getState().history.present;
  store.getState().replaceNodes(replaceMatches(present, findOnBoard(present, "cat"), "dog"));
  store.getState().connectNodes([["a", "b"]]);
  assert.deepEqual(store.getState().history.present.nodes.map((n) => n.text), ["cat", "cat cat"]);
  assert.equal(store.getState().history.present.connectors.length, 0);
  assert.equal(store.getState().history.past.length, 0);
});

test("presenting moves the view without marking the board unsaved", async (t) => {
  const store = await loadAs(t, "edit");
  store.getState().showViewport({ x: 10, y: 20, zoom: 2 });
  assert.deepEqual(store.getState().history.present.viewport, { x: 10, y: 20, zoom: 2 });
  assert.equal(store.getState().history.past.length, 0);
  assert.equal(store.getState().saveStatus, "idle");
});

test("a slide fits and centers its frame on screen", () => {
  const { viewport, box } = slideViewport({ x: 100, y: 100, w: 800, h: 450 }, 1664, 1000, 32);
  assert.equal(viewport.zoom, 2);
  assert.deepEqual(box, { x: 32, y: 50, w: 1600, h: 900 });
});

test("palette search matches every word in any order", () => {
  assert.equal(commandMatches("Board Present frames", "frames pres"), true);
  assert.equal(commandMatches("Board Present frames", "slides"), false);
  assert.equal(commandMatches("Tools Sticky note", ""), true);
});
