import test from "node:test";
import assert from "node:assert/strict";
import {
  BASIC_SHAPES,
  isCreateTool,
  isShapeNode,
  isShapeTool,
  pointInPolygon,
  pointsToPath,
  rayExit,
  shapeDetail,
  shapeKindOfTool,
  shapeOutline,
  shapeRenderPoints,
} from "./shapes";
import { hitTest, marqueeHits, nodeAnchorPoint, resolveEndpoint, connectorPath, resizeNode } from "./geometry";

const PATH_KINDS = BASIC_SHAPES.filter((s) => s.tool.startsWith("shape:")).map((s) => shapeKindOfTool(s.tool));

test("the basic shape set covers Miro's basic shapes", () => {
  assert.deepEqual(BASIC_SHAPES.map((s) => s.label), [
    "Rectangle", "Rounded rectangle", "Circle", "Triangle", "Diamond", "Parallelogram", "Trapezoid",
    "Pentagon", "Hexagon", "Octagon", "Star", "Cross", "Cylinder", "Left arrow", "Right arrow",
    "Double arrow", "Chevron", "Speech bubble", "Cloud",
  ]);
  for (const { tool } of BASIC_SHAPES) {
    assert.equal(isCreateTool(tool), true, tool);
    assert.equal(isShapeTool(tool), true, tool);
  }
  assert.equal(isCreateTool("shape:not-a-shape"), false);
  assert.equal(isCreateTool("connector"), false);
  assert.equal(isShapeTool("sticky"), false);
});

test("every outline is a closed polygon that fills its box exactly", () => {
  for (const kind of PATH_KINDS) {
    for (const [w, h] of [[160, 120], [40, 200], [300, 30]]) {
      const points = shapeOutline(kind, w, h);
      assert.ok(points.length >= 4, kind);
      const xs = points.map((p) => p[0]);
      const ys = points.map((p) => p[1]);
      assert.ok(Math.abs(Math.min(...xs)) < 1e-6 && Math.abs(Math.max(...xs) - w) < 1e-6, `${kind} x extent`);
      assert.ok(Math.abs(Math.min(...ys)) < 1e-6 && Math.abs(Math.max(...ys) - h) < 1e-6, `${kind} y extent`);
      for (const [x, y] of points) assert.ok(Number.isFinite(x) && Number.isFinite(y), kind);
      // The center of every basic shape is inside it (text sits there).
      assert.equal(pointInPolygon({ x: w / 2, y: h / 2 }, points), true, `${kind} center`);
    }
  }
});

test("unknown kinds fall back to a rectangle; only the cylinder has a detail stroke", () => {
  assert.deepEqual(shapeOutline("flowchart-process", 10, 5), [[0, 0], [10, 0], [10, 5], [0, 5]]);
  for (const kind of PATH_KINDS) assert.equal(shapeDetail(kind, 100, 100) !== null, kind === "cylinder", kind);
});

test("render points keep the stroke inside the box", () => {
  const points = shapeRenderPoints("star", 100, 100, 2);
  for (const [x, y] of points) assert.ok(x >= 2 - 1e-9 && x <= 98 + 1e-9 && y >= 2 - 1e-9 && y <= 98 + 1e-9);
  assert.match(pointsToPath(points), /^M[\d.]+ [\d.]+ (L[\d.]+ [\d.]+ )+Z$/);
  assert.equal(pointsToPath([[0, 0], [1, 1]], false), "M0 0 L1 1");
});

test("point-in-polygon and the outermost ray exit", () => {
  const square = [[0, 0], [10, 0], [10, 10], [0, 10]];
  assert.equal(pointInPolygon({ x: 5, y: 5 }, square), true);
  assert.equal(pointInPolygon({ x: 11, y: 5 }, square), false);
  assert.deepEqual(rayExit(square, { x: 5, y: 5 }, { x: 20, y: 5 }), { x: 10, y: 5 });
  assert.equal(rayExit(square, { x: 5, y: 5 }, { x: 5, y: 5 }), null);
  // A concave cross: the ray along the arm exits at the arm's tip, not the notch.
  const cross = shapeOutline("cross", 90, 90);
  assert.deepEqual(rayExit(cross, { x: 45, y: 45 }, { x: 45, y: -100 }), { x: 45, y: 0 });
});

const star = { id: "star", type: "shape", shape: "star", x: 100, y: 100, w: 100, h: 100, fill: "#fff", stroke: "#000", strokeWidth: 2 };
const rect = { id: "rect", type: "rect", x: 100, y: 100, w: 100, h: 100, fill: "#fff", stroke: "#000", strokeWidth: 2 };

test("hit-testing a path shape follows its outline; legacy shapes keep their box", () => {
  assert.equal(hitTest({ nodes: [star] }, { x: 150, y: 150 }), "star");
  assert.equal(hitTest({ nodes: [star] }, { x: 102, y: 102 }), null, "an empty corner of the star's box");
  assert.equal(hitTest({ nodes: [rect, star] }, { x: 102, y: 102 }), "rect", "falls through to the node behind");
  assert.equal(hitTest({ nodes: [rect] }, { x: 102, y: 102 }), "rect");
});

test("marquee selection and resize treat path shapes by their box", () => {
  assert.deepEqual(marqueeHits({ nodes: [star] }, { x: 190, y: 190, w: 50, h: 50 }), ["star"]);
  const resized = resizeNode(star, "se", 50, 20, false);
  assert.equal(resized.shape, "star");
  assert.deepEqual([resized.w, resized.h], [150, 120]);
});

test("connector anchors land on a path shape's outline", () => {
  const top = nodeAnchorPoint(star, "top");
  assert.ok(Math.abs(top.x - 150) < 1e-6 && Math.abs(top.y - 100) < 1e-6, "the star's top tip");
  const arrow = { ...star, id: "arrow", shape: "arrow-right" };
  const right = nodeAnchorPoint(arrow, "right");
  assert.deepEqual([right.x, right.y], [200, 150]);
  // The arrow's shaft is narrower than its box: the top anchor sits on the shaft.
  assert.equal(nodeAnchorPoint(arrow, "top").y, 125);
  assert.deepEqual(nodeAnchorPoint(star, "center"), { x: 150, y: 150 });
  // "auto" exits towards the other end.
  const auto = nodeAnchorPoint(arrow, "auto", { x: 400, y: 150 });
  assert.deepEqual([auto.x, auto.y], [200, 150]);
  const nodesById = { star, arrow };
  assert.deepEqual(resolveEndpoint({ nodeId: "star", anchor: "auto" }, nodesById), { x: 150, y: 150 });
  assert.match(connectorPath({ from: { nodeId: "star", anchor: "top" }, to: { x: 150, y: 0 } }, nodesById), /^M 150 100 /);
});

test("legacy shapes keep their bounding-box anchors", () => {
  assert.deepEqual(nodeAnchorPoint(rect, "top"), { x: 150, y: 100 });
  assert.deepEqual(resolveEndpoint({ nodeId: "rect", anchor: "auto" }, { rect }), { x: 150, y: 100 });
  const triangle = { ...rect, type: "triangle" };
  assert.deepEqual(nodeAnchorPoint(triangle, "left"), { x: 100, y: 150 });
});

test("isShapeNode covers path shapes and the four legacy shapes only", () => {
  for (const type of ["shape", "rect", "ellipse", "triangle", "diamond"]) assert.equal(isShapeNode({ type }), true);
  for (const type of ["text", "sticky", "frame", "image"]) assert.equal(isShapeNode({ type }), false);
});
