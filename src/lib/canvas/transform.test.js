import assert from "node:assert/strict";
import test from "node:test";
import {
  connectorPath,
  fromNodeLocal,
  hitTest,
  marqueeHits,
  nodeAnchorPoint,
  nodeBounds,
  nodeCorners,
  normalizeRotation,
  resizeAnchored,
  resizeNode,
  resolveEndpoint,
  rotatePoint,
  toNodeLocal,
  withRotation,
} from "./geometry.js";
import { cullBoard } from "./culling.js";
import {
  cleanSize,
  groupCenter,
  pointerAngle,
  rotateNodesAbout,
  rotatedResizeCursor,
  rotationDragDelta,
  rotationTargets,
  setImagesAspectLocked,
  setNodesRotation,
  setNodesSize,
  snapAngle,
} from "./transform.js";

const near = (actual, expected, eps = 1e-6) =>
  assert.ok(Math.abs(actual - expected) < eps, `expected ${expected}, got ${actual}`);
const nearPoint = (actual, expected, eps = 1e-6) => {
  near(actual.x, expected.x, eps);
  near(actual.y, expected.y, eps);
};

const rect = (over = {}) => ({ id: "a", type: "rect", x: 0, y: 0, w: 200, h: 100, opacity: 1, parentId: null, groupId: null, ...over });
const board = (nodes, extra = {}) => ({ nodes, connectors: [], viewport: { x: 0, y: 0, zoom: 1 }, ...extra });

test("rotatePoint turns clockwise on screen axes and round-trips through the node frame", () => {
  nearPoint(rotatePoint({ x: 10, y: 0 }, { x: 0, y: 0 }, 90), { x: 0, y: 10 });
  const n = rect({ rotation: 30 });
  const p = { x: 37, y: -12 };
  nearPoint(fromNodeLocal(n, toNodeLocal(n, p)), p);
});

test("normalizeRotation keeps 0 < r < 360 and drops upright angles", () => {
  assert.equal(normalizeRotation(0), 0);
  assert.equal(normalizeRotation(360), 0);
  assert.equal(normalizeRotation(-90), 270);
  assert.equal(normalizeRotation(725), 5);
  assert.equal(normalizeRotation(359.999), 0);
  assert.equal(normalizeRotation(12.3456), 12.35);
  assert.equal(normalizeRotation(Number.NaN), 0);
  assert.equal("rotation" in withRotation(rect({ rotation: 45 }), 360), false);
  assert.equal(withRotation(rect(), 90).rotation, 90);
});

test("nodeBounds of a rotated node is the box around its rotated corners", () => {
  assert.deepEqual(nodeBounds(rect()), { x: 0, y: 0, w: 200, h: 100 });
  const b = nodeBounds(rect({ rotation: 90 }));
  near(b.x, 50);
  near(b.y, -50);
  near(b.w, 100);
  near(b.h, 200);
  const d = nodeBounds(rect({ w: 100, h: 100, rotation: 45 }));
  near(d.w, 100 * Math.SQRT2);
  near(d.x, 50 - 50 * Math.SQRT2);
});

test("hitTest uses the rotated box, not its larger bounds", () => {
  const state = board([rect({ w: 100, h: 100, rotation: 45 })]);
  // Inside the axis-aligned bounds of the diamond, but outside the diamond.
  assert.equal(hitTest(state, { x: 2, y: 2 }), null);
  assert.equal(hitTest(state, { x: 50, y: 50 }), "a");
  // Beyond the unrotated box, but inside the diamond's top tip.
  assert.equal(hitTest(state, { x: 50, y: -15 }), "a");
});

test("hitTest tests a rotated path shape against its rotated outline", () => {
  const state = board([{ ...rect({ type: "shape", shape: "pentagon", w: 100, h: 100 }), rotation: 180 }]);
  // The upright pentagon's apex is at the top center; turned 180 it is at the bottom center.
  assert.equal(hitTest(state, { x: 50, y: 95 }), "a");
  assert.equal(hitTest(state, { x: 50, y: 3 }), "a");
  // Inside the box, but beside the turned pentagon's apex.
  assert.equal(hitTest(state, { x: 3, y: 97 }), null);
});

test("marqueeHits and culling see a rotated node's rotated bounds", () => {
  const n = rect({ x: 0, y: 0, w: 400, h: 20, rotation: 90 });
  // Rotated 90, it spans y -190..210 around x 190..210.
  assert.deepEqual(marqueeHits(board([n]), { x: 195, y: 150, w: 5, h: 5 }), ["a"]);
  assert.deepEqual(marqueeHits(board([n]), { x: 0, y: 0, w: 50, h: 20 }), []);
  const far = rect({ x: 10000, y: 0, w: 4000, h: 20, rotation: 90 });
  // Upright it never reaches y = -1500; rotated it does.
  const vp = { x: 11000, y: -2500, zoom: 1 };
  const size = { w: 100, h: 100 };
  assert.equal(cullBoard(board([{ ...far, rotation: undefined }]), {}, vp, size).nodes.length, 0);
  assert.equal(cullBoard(board([far]), {}, vp, size).nodes.length, 1);
});

test("connector anchors follow the rotated shape", () => {
  const n = rect({ w: 200, h: 100, rotation: 90 });
  // Upright top-center (100, 0) turned 90 about (100, 50) lands at (150, 50).
  nearPoint(nodeAnchorPoint(n, "top"), { x: 150, y: 50 });
  nearPoint(nodeAnchorPoint(n, "right"), { x: 100, y: 150 });
  nearPoint(resolveEndpoint({ nodeId: "a", anchor: "left" }, { a: n }), { x: 100, y: -50 });
  // "auto" towards a point far below exits through the rotated box's bottom (its local right side).
  const auto = nodeAnchorPoint(n, "auto", { x: 100, y: 1000 });
  nearPoint(auto, { x: 100, y: 150 });
  // A rotated path shape's anchor sits on its rotated outline.
  const tri = { ...rect({ type: "shape", shape: "pentagon", w: 100, h: 100 }), rotation: 180 };
  nearPoint(nodeAnchorPoint(tri, "top"), { x: 50, y: 100 });
  const path = connectorPath({ from: { nodeId: "a", anchor: "top" }, to: { x: 400, y: 50 } }, { a: n });
  assert.ok(path.startsWith("M 150 50"), path);
});

test("resizeNode on a rotated node keeps the opposite handle fixed in world space", () => {
  for (const rotation of [30, 90, 200]) {
    const n = rect({ x: 40, y: 60, w: 200, h: 100, rotation });
    const corners = nodeCorners(n);
    // Drag the local south-east corner outward by (30, 20) in local axes.
    const worldDelta = rotatePoint({ x: 30, y: 20 }, { x: 0, y: 0 }, rotation);
    const se = resizeNode(n, "se", worldDelta.x, worldDelta.y, false);
    near(se.w, 230);
    near(se.h, 120);
    assert.equal(se.rotation, rotation);
    nearPoint(nodeCorners(se)[0], corners[0]);
    // The north-west handle keeps the south-east corner.
    const nw = resizeNode(n, "nw", worldDelta.x, worldDelta.y, false);
    near(nw.w, 170);
    near(nw.h, 80);
    nearPoint(nodeCorners(nw)[2], corners[2]);
    // The west edge keeps the local top-right corner.
    const w = resizeNode(n, "w", worldDelta.x, worldDelta.y, false);
    near(w.w, 170);
    near(w.h, 100);
    nearPoint(nodeCorners(w)[1], corners[1]);
  }
});

test("resizeNode without rotation is unchanged", () => {
  assert.deepEqual(resizeNode(rect(), "nw", 10, 20, false), { ...rect(), x: 10, y: 20, w: 190, h: 80 });
});

test("resizeAnchored keeps the chosen point of a rotated box in place", () => {
  const n = rect({ rotation: 45 });
  const grown = resizeAnchored(n, 200, 180);
  nearPoint(nodeCorners(grown)[0], nodeCorners(n)[0]);
  assert.deepEqual(resizeAnchored(rect(), 50, 60), { ...rect(), w: 50, h: 60 });
});

test("pointerAngle, snapping and the drag delta", () => {
  near(pointerAngle({ x: 0, y: 0 }, { x: 0, y: -10 }), 0);
  near(pointerAngle({ x: 0, y: 0 }, { x: 10, y: 0 }), 90);
  assert.equal(snapAngle(22), 15);
  assert.equal(snapAngle(23), 30);
  near(rotationDragDelta(0, 37), 37);
  // A single object at 10 lands on a multiple of 15.
  assert.equal(rotationDragDelta(0, 37, { snap: true, startRotation: 10 }), 35);
  // A group snaps the turn itself.
  assert.equal(rotationDragDelta(0, 37, { snap: true }), 30);
});

test("rotateNodesAbout turns one node in place and a group around its center", () => {
  const single = rotateNodesAbout(board([rect({ rotation: 350 })]), ["a"], 20);
  assert.equal(single.nodes[0].rotation, 10);
  assert.equal(single.nodes[0].x, 0);
  assert.equal(single.nodes[0].y, 0);

  const a = rect({ id: "a", x: 0, y: 0, w: 100, h: 100 });
  const b = rect({ id: "b", x: 200, y: 0, w: 100, h: 100 });
  const center = groupCenter([a, b]);
  assert.deepEqual(center, { x: 150, y: 50 });
  const turned = rotateNodesAbout(board([a, b]), ["a", "b"], 90);
  const [ta, tb] = turned.nodes;
  // a's center (50, 50) orbits to (150, -50); b's (250, 50) to (150, 150).
  nearPoint({ x: ta.x + 50, y: ta.y + 50 }, { x: 150, y: -50 });
  nearPoint({ x: tb.x + 50, y: tb.y + 50 }, { x: 150, y: 150 });
  assert.equal(ta.rotation, 90);
  assert.equal(tb.rotation, 90);
  // A full turn drops the field.
  assert.equal("rotation" in rotateNodesAbout(board([rect({ rotation: 90 })]), ["a"], 270).nodes[0], false);
});

test("rotation skips locked nodes, nodes on locked layers and frames", () => {
  const nodes = [
    rect({ id: "free" }),
    rect({ id: "locked", locked: true }),
    rect({ id: "layered", layerId: "L1" }),
    rect({ id: "frame", type: "frame", w: 600, h: 600 }),
  ];
  const state = board(nodes, { settings: { layers: [{ id: "L1", name: "One", locked: true }] } });
  const ids = nodes.map((n) => n.id);
  assert.deepEqual(rotationTargets(state, ids).map((n) => n.id), ["free"]);
  const next = rotateNodesAbout(state, ids, 45);
  assert.equal(next.nodes[0].rotation, 45);
  for (const n of next.nodes.slice(1)) assert.equal(n.rotation, undefined);
  const set = setNodesRotation(state, ids, 30);
  assert.deepEqual(set.nodes.map((n) => n.rotation), [30, undefined, undefined, undefined]);
  assert.equal(setNodesRotation(state, ["locked", "frame"], 30), state);
});

test("rotating a group re-takes frame membership by the new center", () => {
  const frame = rect({ id: "f", type: "frame", x: 0, y: 0, w: 300, h: 300 });
  const a = rect({ id: "a", x: 20, y: 20, w: 40, h: 40, parentId: "f" });
  const b = rect({ id: "b", x: 520, y: 20, w: 40, h: 40 });
  const next = rotateNodesAbout(board([frame, a, b]), ["a", "b"], 180);
  assert.equal(next.nodes.find((n) => n.id === "a").parentId, null);
  assert.equal(next.nodes.find((n) => n.id === "b").parentId, "f");
});

test("setNodesSize sets whole pixels, honors the minimum and skips locked nodes", () => {
  assert.equal(cleanSize("12.6"), 13);
  assert.equal(cleanSize(1), 4);
  assert.equal(cleanSize("x"), null);
  const state = board([rect({ id: "a" }), rect({ id: "b", locked: true }), rect({ id: "c", x: 500, w: 50 })]);
  const next = setNodesSize(state, ["a", "b", "c"], { w: 120.4 });
  assert.deepEqual(next.nodes.map((n) => n.w), [120, 200, 120]);
  assert.deepEqual(next.nodes.map((n) => n.h), [100, 100, 100]);
  assert.equal(next.nodes[2].x, 500);
  assert.equal(setNodesSize(state, ["a"], { w: 200 }), state);
  assert.equal(setNodesSize(state, ["a"], {}), state);
});

test("setNodesSize keeps a rotated node's top-left corner", () => {
  const n = rect({ rotation: 60 });
  const next = setNodesSize(board([n]), ["a"], { h: 300 });
  nearPoint(nodeCorners(next.nodes[0])[0], nodeCorners(n)[0]);
  assert.equal(next.nodes[0].h, 300);
});

test("an image with its aspect lock on keeps its proportions", () => {
  const img = { id: "i", type: "image", x: 0, y: 0, w: 200, h: 100, src: "/x.png", aspectLocked: true };
  const free = { ...img, id: "j", aspectLocked: false };
  const state = board([img, free]);
  const byW = setNodesSize(state, ["i", "j"], { w: 300 });
  assert.deepEqual(byW.nodes.map((n) => [n.w, n.h]), [[300, 150], [300, 100]]);
  const byH = setNodesSize(state, ["i"], { h: 50 });
  assert.deepEqual([byH.nodes[0].w, byH.nodes[0].h], [100, 50]);
  const unlocked = setImagesAspectLocked(state, ["i", "j"], false);
  assert.deepEqual(unlocked.nodes.map((n) => n.aspectLocked), [false, false]);
  assert.equal(setImagesAspectLocked(state, ["j"], false), state);
});

test("resize cursors follow the node's rotation", () => {
  assert.equal(rotatedResizeCursor(0, 0), "ns-resize");
  assert.equal(rotatedResizeCursor(0, 90), "ew-resize");
  assert.equal(rotatedResizeCursor(90, 45), "nwse-resize");
  assert.equal(rotatedResizeCursor(315, 0), "nwse-resize");
  assert.equal(rotatedResizeCursor(45, 0), "nesw-resize");
});
