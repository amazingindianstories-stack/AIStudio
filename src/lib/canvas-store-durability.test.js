import assert from "node:assert/strict";
import test from "node:test";
import { useCanvasStore } from "./canvas-store.js";
import { readPendingDraft, KEEPALIVE_MAX_BYTES } from "./canvas-pending-draft.js";
import { emptyCanvasState } from "./canvas/serialization.js";


function useStorage(t, value) {
  const had = Object.prototype.hasOwnProperty.call(globalThis, "localStorage");
  const prior = globalThis.localStorage;
  Object.defineProperty(globalThis, "localStorage", { value, configurable: true, writable: true });
  t.after(() => {
    if (had) Object.defineProperty(globalThis, "localStorage", { value: prior, configurable: true, writable: true });
    else delete globalThis.localStorage;
  });
}

function memoryStorage() {
  const map = new Map();
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k) };
}

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function editedState(label) {
  const state = emptyCanvasState();
  return { ...state, viewport: { ...state.viewport, x: label.length } };
}

test("a failed save followed by unmount/reset keeps the edit and restores it on reopen", async (t) => {
  useStorage(t, memoryStorage());
  const calls = [];
  let failSaves = true;
  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    calls.push({ url, method: init.method || "GET", keepalive: init.keepalive });
    if (["PUT", "PATCH"].includes(init.method)) return failSaves ? json(503, {}) : json(200, { updatedAt: Date.now(), version: 2 });
    return json(200, { id: "board-1", name: "Board", data: emptyCanvasState(), updatedAt: 1, version: 1 });
  });
  const store = useCanvasStore;
  store.getState().reset();
  await store.getState().loadBoard("board-1");
  const edit = editedState("edited");
  store.setState({ history: { past: [], present: edit, future: [] }, saveStatus: "dirty" });

  await store.getState().flushSave();
  assert.equal(store.getState().saveStatus, "error");
  store.getState().persistPendingDraft();
  store.getState().reset();
  assert.deepEqual(readPendingDraft("board-1").data, edit);

  failSaves = false;
  await store.getState().loadBoard("board-1");
  assert.deepEqual(store.getState().history.present, edit);
  assert.equal(store.getState().saveStatus, "dirty");
  await store.getState().flushSave();
  assert.equal(store.getState().saveStatus, "saved");
  assert.equal(readPendingDraft("board-1"), null);
  store.getState().reset();
});

test("unload saves use keepalive only for bodies that fit it: the whole graph, else the patch", async (t) => {
  useStorage(t, memoryStorage());
  const saves = [];
  const nodes = Array.from({ length: 1000 }, (_, index) => ({ id: `n${index}`, type: "sticky", x: index * 10, y: 0, w: 120, h: 120, text: "note ".repeat(10) }));
  let board = emptyCanvasState();
  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    if (["PUT", "PATCH"].includes(init.method)) { saves.push(init); return json(200, { updatedAt: Date.now(), version: 2 + saves.length }); }
    return json(200, { id: "board-2", name: "Board", data: board, updatedAt: 1, version: 1 });
  });
  const store = useCanvasStore;
  const edit = (present) => { store.setState({ history: { past: [], present, future: [] }, saveStatus: "dirty" }); return store.getState().flushSave({ keepalive: true }); };
  store.getState().reset();
  await store.getState().loadBoard("board-2");
  // A small board goes whole, as it always did.
  await edit(editedState("small"));
  assert.deepEqual([saves[0].method, saves[0].keepalive], ["PUT", true]);

  // On a large board the whole graph cannot use keepalive, but a small edit's patch can.
  board = { ...emptyCanvasState(), nodes };
  await store.getState().loadBoard("board-2");
  assert.ok(JSON.stringify(board).length > KEEPALIVE_MAX_BYTES);
  const loaded = store.getState().history.present;
  await edit({ ...loaded, nodes: loaded.nodes.map((node) => (node.id === "n7" ? { ...node, text: "moved" } : node)) });
  assert.deepEqual([saves[1].method, saves[1].keepalive], ["PATCH", true]);
  assert.ok(saves[1].body.length < 1000);

  // An edit too large for keepalive either way relies on the pending draft.
  const present = store.getState().history.present;
  await edit({ ...present, nodes: present.nodes.map((node) => ({ ...node, text: "edited ".repeat(30) })) });
  assert.deepEqual([saves[2].method, saves[2].keepalive], ["PATCH", false]);
  store.getState().reset();
});
