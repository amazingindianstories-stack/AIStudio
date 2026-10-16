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
