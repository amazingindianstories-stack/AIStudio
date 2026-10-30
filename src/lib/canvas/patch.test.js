import assert from "node:assert/strict";
import test from "node:test";
import { applyBoardPatch, boardFromChanges, buildBoardPatch, orderHash } from "./patch.js";
import { emptyCanvasState } from "./serialization.js";

const rect = (id, extra = {}) => ({ id, type: "rect", x: 0, y: 0, w: 10, h: 10, ...extra });
const line = (id, from, to) => ({ id, from: { nodeId: from }, to: { nodeId: to } });
const graph = (nodes, connectors = [], viewport = { x: 0, y: 0, zoom: 1 }) => ({ ...emptyCanvasState(), viewport, nodes, connectors });
const ids = (items) => items.map((item) => item.id);

test("a patch carries only the added, changed and deleted objects", () => {
  const base = graph([rect("a"), rect("b"), rect("c")], [line("k", "a", "b")]);
  // An equal copy (as after a save is re-normalized) is not a change; only identity differs.
  const next = graph([{ ...base.nodes[0] }, rect("b", { x: 5 }), rect("d")], [], { x: 9, y: 0, zoom: 2 });
  const patch = buildBoardPatch(base, next);
  assert.deepEqual(patch, {
    viewport: { x: 9, y: 0, zoom: 2 },
    nodes: { upsert: [rect("b", { x: 5 }), rect("d")], add: ["d"], delete: ["c"] },
    connectors: { upsert: [], add: [], delete: ["k"] },
  });
  assert.deepEqual(applyBoardPatch(base, patch), next);
});

test("an untouched board sends an empty patch however many objects it has", () => {
  const nodes = Array.from({ length: 2000 }, (_, index) => rect(`n${index}`, { x: index * 20 }));
  const base = graph(nodes);
  const edited = graph(nodes.map((node) => (node.id === "n1500" ? { ...node, text: "hi" } : node)));
  const patch = buildBoardPatch(base, edited);
  assert.deepEqual(ids(patch.nodes.upsert), ["n1500"]);
  assert.ok(JSON.stringify(patch).length < 200);
  assert.deepEqual(buildBoardPatch(base, base).nodes, { upsert: [], add: [], delete: [] });
});

test("the order is sent only when it is not the old order with new objects on top", () => {
  const base = graph([rect("a"), rect("b"), rect("c")]);
  const appended = graph([rect("a"), rect("c"), rect("d"), rect("e")]);
  assert.equal(buildBoardPatch(base, appended).nodeOrder, undefined);
  for (const order of [["b", "a", "c"], ["a", "d", "b", "c"]]) {
    const next = graph(order.map((id) => rect(id)));
    const patch = buildBoardPatch(base, next);
    assert.deepEqual(patch.nodeOrder, order);
    assert.deepEqual(ids(applyBoardPatch(base, patch).nodes), order);
  }
});

test("random edits round-trip through a patch", () => {
  let seed = 7;
  const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let round = 0; round < 200; round += 1) {
    const base = graph(Array.from({ length: 12 }, (_, index) => rect(`n${index}`)));
    const nodes = base.nodes.filter(() => random() > 0.2).map((node) => (random() > 0.7 ? { ...node, x: round } : node));
    for (let index = 0; index < 3; index += 1) if (random() > 0.5) nodes.splice(Math.floor(random() * nodes.length), 0, rect(`new${index}`));
    if (random() > 0.7) nodes.reverse();
    const next = graph(nodes);
    assert.deepEqual(applyBoardPatch(base, buildBoardPatch(base, next)), next);
  }
});

test("an order that does not name every object once is refused", () => {
  const base = graph([rect("a"), rect("b")]);
  for (const nodeOrder of [["a"], ["a", "a"], ["a", "x"]]) {
    assert.throws(() => applyBoardPatch(base, { nodes: { upsert: [], delete: [] }, nodeOrder }));
  }
});

test("a patch whose add does not name exactly the objects the base lacks is refused", () => {
  // A patch built over a graph that still holds an object the server no longer has (an image
  // held back while it is cropped) would otherwise land that object at a different z-position.
  const base = graph([rect("a"), rect("b")]);
  for (const nodes of [{ upsert: [rect("x")], add: [] }, { upsert: [rect("a")], add: ["a"] }, { upsert: [rect("x"), rect("y")], add: ["x", "x"] }]) {
    assert.throws(() => applyBoardPatch(base, { nodes }));
  }
  assert.deepEqual(ids(applyBoardPatch(base, { nodes: { upsert: [rect("x")], add: ["x"] } }).nodes), ["a", "b", "x"]);
});

test("the order hash matches the server's", () => {
  // Mirrored by test_changed_ids_and_order_hash in backend/apps/canvas/test_patch.py.
  assert.equal(orderHash([]), 0x811c9dc5);
  assert.equal(orderHash(["n1", "é\u{1f600}"]), 3903611430);
  assert.notEqual(orderHash(["a", "b"]), orderHash(["b", "a"]));
});

test("changes rebuild the board over the version they were asked from, unless the order differs", () => {
  const base = graph([rect("a"), rect("b"), rect("c")], [line("k", "a", "b")]);
  const changes = {
    nodes: { upsert: [rect("a", { x: 3 }), rect("d")], delete: ["c"] },
    connectors: { upsert: [], delete: [] },
    nodeOrderHash: orderHash(["a", "b", "d"]),
    connectorOrderHash: orderHash(["k"]),
  };
  const board = boardFromChanges(base, changes);
  assert.deepEqual(board, graph([rect("a", { x: 3 }), rect("b"), rect("d")], [line("k", "a", "b")]));
  assert.equal(board.nodes[1], base.nodes[1]);
  // Someone reordered: the rebuilt order does not match, so the whole board is fetched.
  assert.equal(boardFromChanges(base, { ...changes, nodeOrderHash: orderHash(["b", "a", "d"]) }), null);
});
