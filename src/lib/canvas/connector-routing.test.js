import test from "node:test";
import assert from "node:assert/strict";
import {
  connectorPolyline,
  endpointDirection,
  nearestTOnPolyline,
  pointAtPolyline,
  polylineToPathWithJumps,
  routeOrthogonal,
  simplifyOrthogonalPolyline,
  snapPointToAngle,
} from "./connector-routing.js";

const isOrthogonal = (pts) =>
  pts.every((p, i) => i === 0 || Math.abs(p.x - pts[i - 1].x) < 0.5 || Math.abs(p.y - pts[i - 1].y) < 0.5);
const crossesRect = (pts, n) => pts.some((p, i) => {
  if (i === 0) return false;
  const a = pts[i - 1];
  const minX = Math.min(a.x, p.x), maxX = Math.max(a.x, p.x), minY = Math.min(a.y, p.y), maxY = Math.max(a.y, p.y);
  return maxX > n.x && minX < n.x + n.w && maxY > n.y && minY < n.y + n.h;
});

test("snapPointToAngle snaps to the nearest 45 degree direction and keeps the length", () => {
  const h = snapPointToAngle({ x: 0, y: 0 }, { x: 100, y: 10 });
  assert.ok(Math.abs(h.x - Math.hypot(100, 10)) < 0.01 && h.y === 0);
  const v = snapPointToAngle({ x: 0, y: 0 }, { x: 5, y: 100 });
  assert.ok(v.x === 0 && Math.abs(v.y - Math.hypot(5, 100)) < 0.01);
  const d = snapPointToAngle({ x: 0, y: 0 }, { x: 100, y: 90 });
  assert.ok(Math.abs(d.x - d.y) < 0.02);
  assert.deepEqual(snapPointToAngle({ x: 3, y: 4 }, { x: 3, y: 4 }), { x: 3, y: 4 });
});

test("endpointDirection uses the named anchor, row anchors and the facing side for auto anchors", () => {
  const nodes = { a: { x: 0, y: 0, w: 100, h: 100 } };
  assert.deepEqual(endpointDirection({ nodeId: "a", anchor: "top" }, { x: 0, y: 0 }, { x: 9, y: 9 }, nodes, true), { x: 0, y: -1 });
  assert.deepEqual(endpointDirection({ nodeId: "a", anchor: "row:3:left" }, { x: 0, y: 0 }, { x: 9, y: 9 }, nodes, true), { x: -1, y: 0 });
  assert.deepEqual(endpointDirection({ nodeId: "a", anchor: "row:3:right" }, { x: 0, y: 0 }, { x: 9, y: 9 }, nodes, true), { x: 1, y: 0 });
  assert.deepEqual(endpointDirection({ nodeId: "a" }, { x: 300, y: 50 }, { x: 0, y: 0 }, nodes, true), { x: 1, y: 0 });
  assert.deepEqual(endpointDirection({ nodeId: "a" }, { x: 50, y: -300 }, { x: 0, y: 0 }, nodes, true), { x: 0, y: -1 });
});

test("simplifyOrthogonalPolyline drops duplicate and collinear points", () => {
  const out = simplifyOrthogonalPolyline([
    { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 50, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 80 },
  ]);
  assert.deepEqual(out, [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 80 }]);
  assert.equal(simplifyOrthogonalPolyline([{ x: 1, y: 1 }]).length, 1);
});

test("routeOrthogonal returns axis-aligned segments between free endpoints", () => {
  const c = { from: { x: 0, y: 0 }, to: { x: 200, y: 120 } };
  const pts = routeOrthogonal(c, { x: 0, y: 0 }, { x: 200, y: 120 }, {});
  assert.deepEqual(pts[0], { x: 0, y: 0 });
  assert.deepEqual(pts[pts.length - 1], { x: 200, y: 120 });
  assert.ok(isOrthogonal(pts));
});

test("routeOrthogonal routes through custom waypoints", () => {
  const c = { from: { x: 0, y: 0 }, to: { x: 200, y: 0 }, waypoints: [{ x: 100, y: 150 }] };
  const pts = routeOrthogonal(c, { x: 0, y: 0 }, { x: 200, y: 0 }, {});
  assert.ok(pts.some((p) => p.y >= 150), "the route is pulled down to the waypoint");
  assert.deepEqual(pts[0], { x: 0, y: 0 });
  assert.deepEqual(pts[pts.length - 1], { x: 200, y: 0 });
  assert.ok(isOrthogonal(pts));
});

test("routeOrthogonal routes around an obstacle node between two nodes", () => {
  const nodes = {
    a: { id: "a", type: "sticky", x: 0, y: 100, w: 100, h: 100 },
    b: { id: "b", type: "sticky", x: 500, y: 100, w: 100, h: 100 },
    wall: { id: "wall", type: "sticky", x: 250, y: 60, w: 100, h: 180 },
  };
  const c = { from: { nodeId: "a", anchor: "right" }, to: { nodeId: "b", anchor: "left" } };
  const pts = routeOrthogonal(c, { x: 100, y: 150 }, { x: 500, y: 150 }, nodes);
  assert.ok(isOrthogonal(pts));
  assert.deepEqual(pts[0], { x: 100, y: 150 });
  assert.deepEqual(pts[pts.length - 1], { x: 500, y: 150 });
  assert.equal(crossesRect(pts, nodes.wall), false);
});

test("connectorPolyline: straight keeps waypoints, curved is the default shape, orthogonal routes", () => {
  const from = { x: 0, y: 0 };
  const to = { x: 100, y: 100 };
  assert.deepEqual(connectorPolyline({ shape: "straight", waypoints: [{ x: 50, y: 0 }] }, from, to, {}), [from, { x: 50, y: 0 }, to]);
  assert.deepEqual(connectorPolyline({ shape: "straight" }, from, to, {}), [from, to]);
  const curved = connectorPolyline({ from: { x: 0, y: 0 }, to: { x: 100, y: 100 } }, from, to, {});
  assert.deepEqual(curved[0], from);
  assert.deepEqual(curved[curved.length - 1], to);
  const ortho = connectorPolyline({ shape: "orthogonal", from: { x: 0, y: 0 }, to: { x: 100, y: 100 } }, from, to, {});
  assert.ok(isOrthogonal(ortho));
});

test("pointAtPolyline finds the arc-length midpoint, clamps t and handles degenerate input", () => {
  const pts = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }];
  const mid = pointAtPolyline(pts, 0.5);
  assert.equal(mid.x, 100);
  assert.equal(mid.y, 0);
  assert.deepEqual(pointAtPolyline(pts, 2), { ...pointAtPolyline(pts, 1) });
  assert.equal(pointAtPolyline(pts, 1).y, 100);
  assert.deepEqual(pointAtPolyline([], 0.5), { x: 0, y: 0, angle: 0, rawAngle: 0 });
  const reversed = pointAtPolyline([{ x: 100, y: 0 }, { x: 0, y: 0 }], 0.5);
  assert.equal(reversed.rawAngle, 180);
  assert.equal(reversed.angle, 0);
});

test("nearestTOnPolyline projects a point to a clamped normalized position", () => {
  const pts = [{ x: 0, y: 0 }, { x: 100, y: 0 }];
  assert.ok(Math.abs(nearestTOnPolyline(pts, { x: 50, y: 30 }) - 0.5) < 1e-6);
  assert.equal(nearestTOnPolyline(pts, { x: -50, y: 0 }), 0.05);
  assert.equal(nearestTOnPolyline(pts, { x: 500, y: 0 }), 0.95);
  assert.equal(nearestTOnPolyline([{ x: 0, y: 0 }], { x: 1, y: 1 }), 0.5);
});

test("polylineToPathWithJumps adds a jump where a line crosses an earlier segment and none otherwise", () => {
  const pts = [{ x: 0, y: 50 }, { x: 100, y: 50 }];
  const plain = polylineToPathWithJumps(pts, []);
  assert.equal(plain, "M 0 50 L 100 50");
  const crossing = polylineToPathWithJumps(pts, [[{ x: 50, y: 0 }, { x: 50, y: 100 }]]);
  assert.notEqual(crossing, plain);
  assert.match(crossing, /A /);
  assert.equal(polylineToPathWithJumps([], []), "");
});
