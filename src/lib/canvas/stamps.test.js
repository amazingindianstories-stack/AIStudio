import assert from "node:assert/strict";
import test from "node:test";
import { emptyCanvasState, validateCanvasState } from "./serialization.js";
import { unstamped, withServerStamps } from "./stamps.js";

const rect = (id, extra = {}) => ({ id, type: "rect", x: 0, y: 0, w: 10, h: 10, parentId: null, groupId: null, fill: "#fff", stroke: "#000", strokeWidth: 1, ...extra });
const arrow = (id, extra = {}) => ({ id, from: { x: 0, y: 0 }, to: { x: 5, y: 5 }, kind: "arrow", stroke: "#000", strokeWidth: 2, ...extra });
const stamps = { createdBy: "ana", createdAt: 1, updatedBy: "ben", updatedAt: 2 };

test("validation keeps well-formed stamps on nodes and connectors and drops malformed ones", () => {
  const state = validateCanvasState({
    ...emptyCanvasState(),
    nodes: [rect("a", stamps), rect("b", { createdBy: 7, createdAt: "1", updatedBy: null, updatedAt: Infinity })],
    connectors: [arrow("c", stamps)],
  });
  assert.deepEqual({ ...unstamped(state.nodes[0]), id: "b" }, state.nodes[1]);
  assert.equal(state.nodes[0].createdBy, "ana");
  assert.equal(state.nodes[0].updatedAt, 2);
  assert.equal(state.connectors[0].updatedBy, "ben");
  assert.ok(!("createdBy" in state.nodes[1]) && !("createdAt" in state.nodes[1]));
});

test("unstamped returns an unstamped item itself and strips stamps from a copy", () => {
  const plain = rect("a");
  assert.equal(unstamped(plain), plain);
  const stamped = rect("a", stamps);
  assert.deepEqual(unstamped(stamped), plain);
  assert.equal(stamped.createdBy, "ana");
  assert.equal(unstamped(undefined), undefined);
});

test("withServerStamps replaces the named objects' stamps and keeps every other identity", () => {
  const a = rect("a", { createdBy: "old", createdAt: 0, updatedBy: "old", updatedAt: 0 });
  const b = rect("b");
  const c = arrow("c");
  const state = { ...emptyCanvasState(), nodes: [a, b], connectors: [c] };
  const next = withServerStamps(state, { a: stamps, c: { ...stamps, updatedBy: "ana" } });
  assert.deepEqual(next.nodes[0], rect("a", stamps));
  assert.equal(next.nodes[1], b);
  assert.equal(next.connectors[0].updatedBy, "ana");
  assert.equal(withServerStamps(state, {}), state);
  assert.equal(withServerStamps(state, undefined), state);
  assert.equal(withServerStamps(next, { a: stamps }), next);
});

test("stamps the server dropped (a legacy object) are not invented", () => {
  const state = { ...emptyCanvasState(), nodes: [rect("a", { updatedBy: "x", updatedAt: 1 })], connectors: [] };
  const next = withServerStamps(state, { a: { createdBy: "ana", createdAt: 3 } });
  assert.deepEqual(next.nodes[0], rect("a", { createdBy: "ana", createdAt: 3 }));
});
