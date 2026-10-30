import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_INK_POINTS, eraseAt, eraseInkPart, inkIdsAt, inkNodeFromPoints, inkPathD, inkWorldPoints, pressureWidth, simplifyPoints, simplifyStroke,
} from "./ink.js";

const line = (n, y = 0) => Array.from({ length: n }, (_, i) => ({ x: i, y }));
const style = { stroke: "#ffffff", strokeWidth: 4 };

test("simplifying drops collinear points and keeps corners", () => {
  const corner = [...line(50), ...Array.from({ length: 50 }, (_, i) => ({ x: 49, y: i + 1 }))];
  const result = simplifyPoints(corner, 0.5);
  assert.deepEqual(result, [corner[0], corner[49], corner[99]]);
});

test("a long noisy stroke stays within the per-stroke point cap", () => {
  const noisy = Array.from({ length: 20000 }, (_, i) => ({ x: i * 0.2, y: Math.sin(i / 3) * 40 + (i % 7) }));
  assert.ok(simplifyStroke(noisy, 1).length <= MAX_INK_POINTS);
});

test("an ink node stores rounded flat points relative to its box and rebuilds world points", () => {
  const node = inkNodeFromPoints([{ x: 100.04, y: 50 }, { x: 150, y: 80.26 }], style, "i1");
  assert.equal(node.type, "ink");
  assert.deepEqual([node.x, node.y, node.w, node.h], [100, 50, 50, 30.3]);
  assert.deepEqual(node.pts, [0, 0, 50, 30.3]);
  const world = inkWorldPoints(node);
  assert.deepEqual(world.map((p) => [p.x, p.y]), [[100, 50], [150, 80.3]]);
  assert.match(inkPathD(node), /^M 0 0 L 50 30.3$/);
});

test("resizing the box scales the stroke", () => {
  const node = { ...inkNodeFromPoints([{ x: 0, y: 0 }, { x: 10, y: 10 }], style, "i1"), w: 20, h: 40 };
  assert.deepEqual(inkWorldPoints(node).map((p) => [p.x, p.y]), [[0, 0], [20, 40]]);
});

test("a highlighter stroke is translucent", () => {
  const node = inkNodeFromPoints(line(3), { ...style, highlighter: true }, "h");
  assert.equal(node.highlighter, true);
  assert.equal(node.opacity, 0.4);
});

test("a degenerate dot gets a minimum box", () => {
  const node = inkNodeFromPoints([{ x: 5, y: 5 }], style, "dot");
  assert.ok(node.w >= 2 && node.h >= 2);
});

test("the whole-stroke eraser removes only strokes the circle touches", () => {
  const near = inkNodeFromPoints(line(100), style, "near");
  const far = inkNodeFromPoints(line(100, 300), style, "far");
  assert.deepEqual(inkIdsAt([near, far], { x: 50, y: 6 }, 6), ["near"]);
  const state = { nodes: [near, far, { id: "r", type: "rect", x: 0, y: 0, w: 99, h: 99 }], connectors: [] };
  const after = eraseAt(state, { x: 50, y: 3 }, 6, false);
  assert.deepEqual(after.nodes.map((n) => n.id), ["far", "r"]);
  assert.equal(eraseAt(state, { x: 900, y: 900 }, 6, false), state, "a miss changes nothing");
});

test("the precision eraser splits a stroke around the erased part", () => {
  const node = inkNodeFromPoints(line(101), style, "s");
  const pieces = eraseInkPart(node, { x: 50, y: 0 }, 8);
  assert.equal(pieces.length, 2);
  assert.equal(pieces[0].id, "s");
  assert.notEqual(pieces[1].id, "s");
  assert.ok(pieces[0].x + pieces[0].w < 50 && pieces[1].x > 50);
  assert.equal(eraseInkPart(node, { x: 50, y: 200 }, 8), null);
});

test("the precision eraser leaves nothing when it covers a short stroke", () => {
  const node = inkNodeFromPoints(line(5), style, "s");
  assert.deepEqual(eraseInkPart(node, { x: 2, y: 0 }, 20), []);
  const state = eraseAt({ nodes: [node], connectors: [] }, { x: 2, y: 0 }, 20, true);
  assert.equal(state.nodes.length, 0);
});

test("a stylus varies width with pressure and a mouse keeps the preset", () => {
  assert.equal(pressureWidth(4, "mouse", [0.5]), 4);
  assert.equal(pressureWidth(4, "pen", [1]), 6);
  assert.equal(pressureWidth(4, "pen", [0]), 2);
  assert.equal(pressureWidth(4, "pen", []), 4);
});
