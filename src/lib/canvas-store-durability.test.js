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
    if ((init.method || "GET") === "PUT") return failSaves ? json(503, {}) : json(200, { updatedAt: Date.now(), version: 2 });
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

test("large boards never use keepalive, small ones may", async (t) => {
  useStorage(t, memoryStorage());
  const puts = [];
  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    if ((init.method || "GET") === "PUT") { puts.push(init); return json(200, { updatedAt: Date.now(), version: 2 }); }
    return json(200, { id: "board-2", name: "Board", data: emptyCanvasState(), updatedAt: 1, version: 1 });
  });
  const store = useCanvasStore;
  store.getState().reset();
  await store.getState().loadBoard("board-2");
  store.setState({ history: { past: [], present: editedState("small"), future: [] }, saveStatus: "dirty" });
  await store.getState().flushSave({ keepalive: true });
  const big = { ...emptyCanvasState(), padding: "x".repeat(KEEPALIVE_MAX_BYTES + 100) };
  store.setState({ history: { past: [], present: big, future: [] }, saveStatus: "dirty" });
  await store.getState().flushSave({ keepalive: true });
  assert.equal(puts[0].keepalive, true);
  assert.equal(puts[1].keepalive, false);
  store.getState().reset();
});
