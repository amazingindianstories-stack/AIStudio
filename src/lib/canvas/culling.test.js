import assert from "node:assert/strict";
import test from "node:test";
import { cullBoard, cullRect, CULL_OVERSCAN_PX } from "./culling.js";

const rect = (id, x, y, extra = {}) => ({ id, type: "rect", x, y, w: 100, h: 100, ...extra });
const line = (id, from, to) => ({ id, from: typeof from === "string" ? { nodeId: from, anchor: "auto" } : from, to: typeof to === "string" ? { nodeId: to, anchor: "auto" } : to });
const byId = (nodes) => Object.fromEntries(nodes.map((node) => [node.id, node]));
const ids = (items) => items.map((item) => item.id);
const viewport = { x: 0, y: 0, zoom: 1 };
const size = { w: 1000, h: 800 };
const far = 1000 + CULL_OVERSCAN_PX + 500;

function cull(nodes, connectors = [], keep, vp = viewport) {
  return cullBoard({ nodes, connectors }, byId(nodes), vp, size, keep);
}

test("the mounted rectangle is the viewport grown by the overscan in screen pixels", () => {
  assert.deepEqual(cullRect({ x: 100, y: 50, zoom: 2 }, size), { left: -350, top: -400, right: 1050, bottom: 900 });
});

test("only nodes meeting the viewport plus overscan are mounted, in board order", () => {
  const nodes = [rect("in", 10, 10), rect("edge", 1000 + CULL_OVERSCAN_PX, 0), rect("left", -CULL_OVERSCAN_PX - 100, 0), rect("out", far, 0), rect("below", 0, far)];
  assert.deepEqual(ids(cull(nodes).nodes), ["in", "edge", "left"]);
  // Zoomed out, the same screen covers more of the world.
  assert.deepEqual(ids(cull(nodes, [], {}, { x: 0, y: 0, zoom: 0.25 }).nodes), ["in", "edge", "left", "out", "below"]);
});

test("selected, edited, cropped and pinned nodes stay mounted off screen", () => {
  const nodes = [rect("a", far, 0), rect("b", far, far), rect("c", 0, 0), rect("d", -far, 0)];
  assert.deepEqual(ids(cull(nodes).nodes), ["c"]);
  assert.deepEqual(ids(cull(nodes, [], { nodeIds: ["d", "a"] }).nodes), ["a", "c", "d"]);
});

test("a connector is mounted when its curve can reach the view, with both of its ends", () => {
  const nodes = [rect("near", 0, 0), rect("far1", far, 0), rect("far2", far, far), rect("far3", far + 200, far)];
  const connectors = [line("across", "near", "far1"), line("offscreen", "far2", "far3"), line("free", { x: -far, y: 400 }, { x: far * 2, y: 400 })];
  const result = cull(nodes, connectors);
  assert.deepEqual(ids(result.connectors), ["across", "free"]);
  assert.deepEqual(ids(result.nodes), ["near", "far1"]);
  // A selected connector stays mounted, ends included.
  assert.deepEqual(ids(cull(nodes, connectors, { connectorIds: ["offscreen"] }).nodes), ["near", "far1", "far2", "far3"]);
});

test("a connector whose bow could curve into view is mounted", () => {
  const edge = 1000 + CULL_OVERSCAN_PX;
  const nodes = [rect("a", edge + 50, 0), rect("b", edge + 50, 2000)];
  assert.deepEqual(ids(cull(nodes, [line("k", "a", "b")]).connectors), ["k"]);
  const away = [rect("a", edge + 70, 0), rect("b", edge + 70, 2000)];
  assert.deepEqual(ids(cull(away, [line("k", "a", "b")]).connectors), []);
});

test("a connector to a missing node is not mounted", () => {
  assert.deepEqual(cull([rect("a", 0, 0)], [line("k", "a", "gone")]).connectors, []);
});

test("culling a 5,000-object board is cheap enough for every pan frame", () => {
  const nodes = Array.from({ length: 5000 }, (_, index) => rect(`n${index}`, (index % 100) * 150, Math.floor(index / 100) * 150));
  const connectors = Array.from({ length: 1000 }, (_, index) => line(`k${index}`, `n${index}`, `n${index + 1}`));
  const map = byId(nodes);
  const started = performance.now();
  let mounted;
  for (let frame = 0; frame < 60; frame += 1) mounted = cullBoard({ nodes, connectors }, map, { x: frame * 10, y: 0, zoom: 1 }, size);
  assert.ok((performance.now() - started) / 60 < 8, "under 8 ms a frame");
  assert.ok(mounted.nodes.length < 400);
});
