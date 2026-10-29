import assert from "node:assert/strict";
import test from "node:test";
import {
  KEEPALIVE_MAX_BYTES,
  clearPendingDraft,
  readPendingDraft,
  savePendingDraft,
  shouldUseKeepalive,
} from "./canvas-pending-draft.js";


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
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    map,
  };
}

test("keepalive is only used below the browser body quota", () => {
  assert.equal(shouldUseKeepalive("x".repeat(1000)), true);
  assert.equal(shouldUseKeepalive("x".repeat(KEEPALIVE_MAX_BYTES + 1)), false);
  // Multi-byte characters count in bytes, not string length.
  assert.equal(shouldUseKeepalive("é".repeat(KEEPALIVE_MAX_BYTES / 2 + 10)), false);
});

test("pending draft is cleared only by an acknowledgement of the same content", (t) => {
  const store = memoryStorage();
  useStorage(t, store);
  assert.equal(savePendingDraft("board-1", { nodes: [1] }, 100), true);
  assert.deepEqual(readPendingDraft("board-1"), { at: 100, data: { nodes: [1] } });
  savePendingDraft("board-1", { nodes: [1, 2] }, 200);
  clearPendingDraft("board-1", { nodes: [1] }); // stale ack must not drop the newer edit
  assert.deepEqual(readPendingDraft("board-1").data, { nodes: [1, 2] });
  clearPendingDraft("board-1", { nodes: [1, 2] });
  assert.equal(readPendingDraft("board-1"), null);
});

test("storage failures never throw into the editor", (t) => {
  useStorage(t, {
    getItem: () => { throw new Error("blocked"); },
    setItem: () => { throw new Error("quota"); },
    removeItem: () => { throw new Error("blocked"); },
  });
  assert.equal(savePendingDraft("b", { a: 1 }), false);
  assert.equal(readPendingDraft("b"), null);
  assert.doesNotThrow(() => clearPendingDraft("b", { a: 1 }));
});

test("a draft keeps its sync base when it fits and falls back to only the base version", (t) => {
  const store = memoryStorage();
  useStorage(t, store);
  assert.equal(savePendingDraft("board-1", { nodes: [1] }, 100, { baseVersion: 4, base: { nodes: [] } }), true);
  assert.deepEqual(readPendingDraft("board-1"), { at: 100, data: { nodes: [1] }, baseVersion: 4, base: { nodes: [] } });
  const big = { nodes: ["x".repeat(4 * 1024 * 1024)] };
  assert.equal(savePendingDraft("board-1", { nodes: [2] }, 200, { baseVersion: 5, base: big }), true);
  assert.deepEqual(readPendingDraft("board-1"), { at: 200, data: { nodes: [2] }, baseVersion: 5 });
});

test("a draft over the browser's storage quota falls back to the draft without its base graph", (t) => {
  const store = memoryStorage();
  const setItem = store.setItem.bind(store);
  store.setItem = (key, value) => {
    if (value.length > 100) throw new DOMException("quota", "QuotaExceededError");
    setItem(key, value);
  };
  useStorage(t, store);
  assert.equal(savePendingDraft("board-1", { nodes: [1] }, 100, { baseVersion: 4, base: { nodes: ["x".repeat(200)] } }), true);
  assert.deepEqual(readPendingDraft("board-1"), { at: 100, data: { nodes: [1] }, baseVersion: 4 });
  assert.equal(savePendingDraft("board-1", { nodes: ["y".repeat(200)] }, 200, { baseVersion: 5, base: { nodes: [] } }), false);
  assert.deepEqual(readPendingDraft("board-1"), { at: 100, data: { nodes: [1] }, baseVersion: 4 });
});

test("a draft names the unresolved save: by id when it is that save, with its graph when edits came after", (t) => {
  const store = memoryStorage();
  useStorage(t, store);
  const sent = { nodes: [1] };
  savePendingDraft("board-1", sent, 100, { baseVersion: 4, base: { nodes: [] }, save: { id: "s1", data: sent } });
  assert.deepEqual(readPendingDraft("board-1"), { at: 100, data: sent, baseVersion: 4, base: { nodes: [] }, save: { id: "s1" } });
  savePendingDraft("board-1", { nodes: [1, 2] }, 200, { baseVersion: 4, base: { nodes: [] }, save: { id: "s1", data: sent } });
  assert.deepEqual(readPendingDraft("board-1").save, { id: "s1", data: sent });
  // Without room for graphs, only a save of exactly this content keeps its id.
  const big = { nodes: ["x".repeat(4 * 1024 * 1024)] };
  savePendingDraft("board-1", { nodes: [3] }, 300, { baseVersion: 5, base: big, save: { id: "s2", data: big } });
  assert.deepEqual(readPendingDraft("board-1"), { at: 300, data: { nodes: [3] }, baseVersion: 5 });
});

test("a full storage evicts other boards' drafts oldest first, never this board's or other data", (t) => {
  const map = new Map();
  const capacity = 400;
  const used = () => [...map].reduce((sum, [key, value]) => sum + key.length + value.length, 0);
  const store = {
    get length() { return map.size; },
    key: (index) => [...map.keys()][index] ?? null,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => {
      const before = map.get(key);
      map.set(key, String(value));
      if (used() > capacity) {
        if (before === undefined) map.delete(key); else map.set(key, before);
        throw new DOMException("full", "QuotaExceededError");
      }
    },
    removeItem: (key) => map.delete(key),
  };
  useStorage(t, store);
  map.set("unrelated-app-setting", "keep");
  for (const [board, at] of [["mid", 20], ["old", 10], ["new", 30]]) savePendingDraft(board, { nodes: ["x".repeat(40)] }, at);
  assert.equal(savePendingDraft("board-1", { nodes: ["y".repeat(150)] }, 40), true);
  assert.deepEqual(readPendingDraft("old"), null);
  assert.deepEqual(readPendingDraft("mid"), null);
  assert.equal(readPendingDraft("new").at, 30);
  assert.equal(readPendingDraft("board-1").at, 40);
  assert.equal(map.get("unrelated-app-setting"), "keep");
});
