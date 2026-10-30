/**
 * Store tests for the board-wide view settings (background color and start
 * view): who may change them, undo, and the first-visit start view on load.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { useCanvasStore } from "./canvas-store.js";
import { emptyCanvasState } from "./canvas/serialization.js";
import { MAX_ZOOM } from "./canvas/geometry.js";

function useStorage(t) {
  const map = new Map();
  const value = { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k) };
  const had = Object.prototype.hasOwnProperty.call(globalThis, "localStorage");
  const prior = globalThis.localStorage;
  Object.defineProperty(globalThis, "localStorage", { value, configurable: true, writable: true });
  t.after(() => {
    if (had) Object.defineProperty(globalThis, "localStorage", { value: prior, configurable: true, writable: true });
    else delete globalThis.localStorage;
  });
  return map;
}

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function serve(t, role, data = emptyCanvasState()) {
  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    if ((init.method || "GET") !== "GET") return json(200, { ok: true, updatedAt: Date.now() });
    return json(200, { id: "board-1", name: "Board", data, updatedAt: 1, role });
  });
}

async function open(t, role, data) {
  serve(t, role, data);
  const store = useCanvasStore;
  store.getState().reset();
  await store.getState().loadBoard("board-1");
  t.after(() => store.getState().reset());
  return store;
}

test("an editor sets and clears the board background as one undo step each", async (t) => {
  useStorage(t);
  const store = await open(t, "edit");
  store.getState().setBoardBackground("#121A2E");
  assert.equal(store.getState().history.present.settings?.background, "#121a2e");
  assert.equal(store.getState().saveStatus, "dirty");

  store.getState().setBoardBackground("#121a2e");
  assert.equal(store.getState().history.past.length, 1, "the same color is no change");

  store.getState().setBoardBackground("not-a-color");
  store.getState().setBoardBackground("url(x)");
  assert.equal(store.getState().history.present.settings?.background, "#121a2e", "malformed colors are ignored");

  store.getState().setBoardBackground(null);
  assert.equal(store.getState().history.present.settings, undefined, "the default stores no setting");
  store.getState().undo();
  assert.equal(store.getState().history.present.settings?.background, "#121a2e");
});

for (const role of ["view", "comment"]) {
  test(`a ${role}-only person cannot change the background or the start view`, async (t) => {
    useStorage(t);
    const store = await open(t, role);
    store.getState().setBoardBackground("#121a2e");
    store.getState().setStartView({ x: 1, y: 2, zoom: 1 });
    assert.equal(store.getState().history.present.settings, undefined);
    assert.equal(store.getState().history.past.length, 0);
  });
}

test("an editor below co-owner cannot set or clear the start view", async (t) => {
  useStorage(t);
  const store = await open(t, "edit", { ...emptyCanvasState(), settings: { startView: { x: 5, y: 5, zoom: 1 } } });
  store.getState().setStartView({ x: 1, y: 2, zoom: 1 });
  store.getState().clearStartView();
  assert.deepEqual(store.getState().history.present.settings?.startView, { x: 5, y: 5, zoom: 1 });
});

for (const role of ["owner", "co_owner"]) {
  test(`a board ${role} sets the current view as start view and clears it`, async (t) => {
    useStorage(t);
    const store = await open(t, role);
    store.getState().setViewport({ x: 120, y: -40, zoom: 1.5 });
    store.getState().setStartView();
    assert.deepEqual(store.getState().history.present.settings?.startView, { x: 120, y: -40, zoom: 1.5 });

    store.getState().setStartView({ x: 0, y: 0, zoom: 900 });
    assert.equal(store.getState().history.present.settings.startView.zoom, MAX_ZOOM);
    store.getState().setStartView({ x: NaN, y: 0, zoom: 1 });
    store.getState().setStartView({ x: 0, y: 0, zoom: 0 });
    assert.equal(store.getState().history.present.settings.startView.zoom, MAX_ZOOM, "invalid views are ignored");

    store.getState().setBoardBackground("#13251c");
    store.getState().clearStartView();
    assert.deepEqual(store.getState().history.present.settings, { background: "#13251c" }, "clearing keeps other settings");
  });
}

test("a first visit opens at the start view; a repeat visit keeps the saved viewport", async (t) => {
  useStorage(t);
  const data = { ...emptyCanvasState(), viewport: { x: 1, y: 1, zoom: 1 }, settings: { startView: { x: 800, y: 600, zoom: 0.5 } } };
  let store = await open(t, "view", data);
  assert.deepEqual(store.getState().history.present.viewport, { x: 800, y: 600, zoom: 0.5 });
  assert.equal(store.getState().saveStatus, "idle", "opening at the start view saves nothing");

  t.mock.restoreAll();
  store = await open(t, "view", data);
  assert.deepEqual(store.getState().history.present.viewport, { x: 1, y: 1, zoom: 1 });
});
