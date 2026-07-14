/**
 * Unit tests for src/lib/canvas/geometry.ts — the pure coordinate/hit-testing
 * geometry helpers for the Canvas Board whiteboard.
 *
 * Derived independently from the "Data model" and "Interfaces" sections of
 * .council/canvas-board/design.md (the documented contract), BEFORE reading
 * any implementation under src/lib/canvas/, src/lib/canvas-store.ts,
 * src/lib/canvas-db.ts, src/app/api/canvas-boards/, or src/components/canvas/.
 * Pure module: no DOM, no network. Run:
 *   npx tsx --test src/lib/canvas/geometry.test.ts
 *
 * Interpreted ambiguities (see final report for full detail):
 *  - `resolveEndpoint(ep, nodesById)` is documented with only two params, but
 *    design.md's prose says anchor "auto" resolves to "the point on the
 *    node's bounding-box perimeter nearest the OTHER endpoint" — which this
 *    2-arg signature cannot know in isolation. Tests below treat resolveEndpoint's
 *    "auto" case leniently (no-throw + finite point) and instead verify the
 *    documented "nearest-perimeter-point" directional behavior through
 *    connectorPath, which does see both endpoints.
 *  - `resizeNode`'s `handle` parameter has no documented type/enum. Tests
 *    assume the common compass-corner convention ("se" = bottom-right grow,
 *    "nw" = top-left, origin moves with it) as the most defensible default
 *    for a FigJam-style resize handle set.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  worldToScreen,
  screenToWorld,
  nodeBounds,
  boundsContain,
  moveNodesBy,
  applyFrameMove,
  resizeNode,
  computeFrameMembership,
  resolveEndpoint,
  connectorPath,
  hitTest,
  marqueeHits,
} from "./geometry";
import type {
  CanvasState,
  CanvasNode,
  ShapeNode,
  FrameNode,
  Connector,
  Viewport,
} from "./types";

// ---------------------------------------------------------------------------
// Fixture builders — field sets copied verbatim from design.md's Data model.
// ---------------------------------------------------------------------------

function rect(overrides: Partial<ShapeNode> = {}): ShapeNode {
  return {
    id: "rect1",
    type: "rect",
    x: 0,
    y: 0,
    w: 100,
    h: 50,
    fill: "#ffffff",
    stroke: "#000000",
    strokeWidth: 1,
    parentId: null,
    groupId: null,
    ...overrides,
  };
}

function frame(overrides: Partial<FrameNode> = {}): FrameNode {
  return {
    id: "frame1",
    type: "frame",
    x: 0,
    y: 0,
    w: 200,
    h: 200,
    name: "Section",
    fill: "#eeeeee",
    stroke: "#333333",
    parentId: null,
    groupId: null,
    ...overrides,
  };
}

function emptyState(overrides: Partial<CanvasState> = {}): CanvasState {
  return {
    version: 1,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [],
    connectors: [],
    ...overrides,
  };
}

function byId(nodes: CanvasNode[]): Record<string, CanvasNode> {
  return Object.fromEntries(nodes.map((n) => [n.id, n]));
}

function closeTo(a: number, b: number, eps = 1e-6) {
  assert.ok(Math.abs(a - b) < eps, `expected ${a} ~= ${b}`);
}

// ---------------------------------------------------------------------------
// worldToScreen / screenToWorld
// ---------------------------------------------------------------------------

const VIEWPORTS: Viewport[] = [
  { x: 0, y: 0, zoom: 1 },
  { x: 100, y: -50, zoom: 1 },
  { x: 0, y: 0, zoom: 2.5 },
  { x: 37, y: -12, zoom: 0.5 },
];

test("worldToScreen -> screenToWorld round-trips to the original world point across viewports", () => {
  const worldPoints = [
    { x: 0, y: 0 },
    { x: 123.5, y: -87.25 },
    { x: -400, y: 900 },
  ];
  for (const vp of VIEWPORTS) {
    for (const p of worldPoints) {
      const screen = worldToScreen(p, vp);
      const back = screenToWorld(screen, vp);
      closeTo(back.x, p.x);
      closeTo(back.y, p.y);
    }
  }
});

test("screenToWorld -> worldToScreen round-trips to the original screen point across viewports", () => {
  const screenPoints = [
    { x: 0, y: 0 },
    { x: 640, y: 360 },
    { x: -50, y: 1200 },
  ];
  for (const vp of VIEWPORTS) {
    for (const p of screenPoints) {
      const world = screenToWorld(p, vp);
      const back = worldToScreen(world, vp);
      closeTo(back.x, p.x);
      closeTo(back.y, p.y);
    }
  }
});

test("worldToScreen: identity viewport {0,0,1} is a pass-through", () => {
  const p = { x: 42, y: -17 };
  const screen = worldToScreen(p, { x: 0, y: 0, zoom: 1 });
  closeTo(screen.x, p.x);
  closeTo(screen.y, p.y);
});

// ---------------------------------------------------------------------------
// nodeBounds / boundsContain
// ---------------------------------------------------------------------------

test("nodeBounds: extracts {x,y,w,h} matching the node's own fields", () => {
  const n = rect({ x: 10, y: 20, w: 30, h: 40 });
  const b = nodeBounds(n);
  assert.equal(b.x, 10);
  assert.equal(b.y, 20);
  assert.equal(b.w, 30);
  assert.equal(b.h, 40);
});

test("boundsContain: a point clearly inside the outer bounds is contained", () => {
  const outer = { x: 0, y: 0, w: 100, h: 100 };
  assert.equal(boundsContain(outer, { x: 50, y: 50 }), true);
});

test("boundsContain: points clearly outside on each side are not contained", () => {
  const outer = { x: 0, y: 0, w: 100, h: 100 };
  assert.equal(boundsContain(outer, { x: -10, y: 50 }), false, "left of outer");
  assert.equal(boundsContain(outer, { x: 110, y: 50 }), false, "right of outer");
  assert.equal(boundsContain(outer, { x: 50, y: -10 }), false, "above outer");
  assert.equal(boundsContain(outer, { x: 50, y: 110 }), false, "below outer");
});

// ---------------------------------------------------------------------------
// resolveEndpoint
// ---------------------------------------------------------------------------

test("resolveEndpoint: a FREE endpoint ({x,y}, no nodeId) resolves to exactly that point", () => {
  const nodesById = byId([rect()]);
  const result = resolveEndpoint({ x: 12.5, y: -3 }, nodesById);
  assert.equal(result.x, 12.5);
  assert.equal(result.y, -3);
});

test("resolveEndpoint: named anchors resolve to the documented perimeter/center points", () => {
  const n = rect({ id: "n1", x: 10, y: 20, w: 100, h: 50 });
  const nodesById = byId([n]);
  assert.deepEqual(resolveEndpoint({ nodeId: "n1", anchor: "top" }, nodesById), { x: 60, y: 20 });
  assert.deepEqual(resolveEndpoint({ nodeId: "n1", anchor: "bottom" }, nodesById), { x: 60, y: 70 });
  assert.deepEqual(resolveEndpoint({ nodeId: "n1", anchor: "left" }, nodesById), { x: 10, y: 45 });
  assert.deepEqual(resolveEndpoint({ nodeId: "n1", anchor: "right" }, nodesById), { x: 110, y: 45 });
  assert.deepEqual(resolveEndpoint({ nodeId: "n1", anchor: "center" }, nodesById), { x: 60, y: 45 });
});

test("resolveEndpoint: anchor 'auto' does not throw and resolves to a finite point (exact point is context-dependent — see connectorPath tests for the directional 'nearest' behavior)", () => {
  const n = rect({ id: "n1", x: 10, y: 20, w: 100, h: 50 });
  const nodesById = byId([n]);
  const result = resolveEndpoint({ nodeId: "n1", anchor: "auto" }, nodesById);
  assert.equal(Number.isFinite(result.x), true);
  assert.equal(Number.isFinite(result.y), true);
});

// ---------------------------------------------------------------------------
// computeFrameMembership
// ---------------------------------------------------------------------------

test("computeFrameMembership: node whose center is inside a single frame's bounds returns that frame's id", () => {
  const node = rect({ id: "child", x: 50, y: 50, w: 20, h: 20 }); // center (60,60)
  const f = frame({ id: "f1", x: 0, y: 0, w: 100, h: 100 });
  assert.equal(computeFrameMembership(node, [f]), "f1");
});

test("computeFrameMembership: node outside every frame returns null", () => {
  const node = rect({ id: "child", x: 1000, y: 1000, w: 20, h: 20 });
  const f = frame({ id: "f1", x: 0, y: 0, w: 100, h: 100 });
  assert.equal(computeFrameMembership(node, [f]), null);
});

test("computeFrameMembership: no frames at all returns null", () => {
  const node = rect({ id: "child", x: 10, y: 10, w: 20, h: 20 });
  assert.equal(computeFrameMembership(node, []), null);
});

test("computeFrameMembership: overlapping frames — the front-most (highest array index) frame wins", () => {
  const node = rect({ id: "child", x: 50, y: 50, w: 20, h: 20 }); // center (60,60)
  const a = frame({ id: "A", x: 0, y: 0, w: 100, h: 100 });
  const b = frame({ id: "B", x: 40, y: 40, w: 100, h: 100 });
  // Both A and B contain the node's center. Array order encodes z-order
  // (design.md: "ARRAY ORDER == Z-ORDER (index 0 = back, last = front)").
  assert.equal(computeFrameMembership(node, [a, b]), "B", "B is last => front-most => wins");
  assert.equal(computeFrameMembership(node, [b, a]), "A", "order flipped => A is now front-most => wins");
});

// ---------------------------------------------------------------------------
// applyFrameMove
// ---------------------------------------------------------------------------

test("applyFrameMove: frame and every node with matching parentId move by the exact same delta, and nothing else changes", () => {
  const f = frame({ id: "f1", x: 0, y: 0, w: 200, h: 200 });
  const c1 = rect({ id: "c1", parentId: "f1", x: 10, y: 10, w: 20, h: 20 });
  const c2 = rect({ id: "c2", parentId: "f1", x: 50, y: 50, w: 20, h: 20 });
  const other = rect({ id: "c3", parentId: "other-frame", x: 20, y: 20, w: 20, h: 20 });
  const sibling = rect({ id: "s1", parentId: null, x: 500, y: 500, w: 20, h: 20 });
  const conn: Connector = {
    id: "conn1",
    from: { nodeId: "c1", anchor: "auto" },
    to: { nodeId: "s1", anchor: "center" },
    kind: "arrow",
    stroke: "#000",
    strokeWidth: 2,
  };
  const state = emptyState({
    nodes: [f, c1, c2, other, sibling],
    connectors: [conn],
    viewport: { x: 5, y: 5, zoom: 1.2 },
  });
  const before = JSON.parse(JSON.stringify(state));

  const dx = 15;
  const dy = -5;
  const result = applyFrameMove(state, "f1", dx, dy);

  const rf = result.nodes.find((n) => n.id === "f1")!;
  const rc1 = result.nodes.find((n) => n.id === "c1")!;
  const rc2 = result.nodes.find((n) => n.id === "c2")!;
  const rc3 = result.nodes.find((n) => n.id === "c3")!;
  const rs1 = result.nodes.find((n) => n.id === "s1")!;

  assert.equal(rf.x, f.x + dx);
  assert.equal(rf.y, f.y + dy);
  assert.equal(rc1.x, c1.x + dx);
  assert.equal(rc1.y, c1.y + dy);
  assert.equal(rc2.x, c2.x + dx);
  assert.equal(rc2.y, c2.y + dy);

  // Nothing else changes: different-parent and unparented nodes untouched.
  assert.equal(rc3.x, other.x);
  assert.equal(rc3.y, other.y);
  assert.equal(rs1.x, sibling.x);
  assert.equal(rs1.y, sibling.y);

  // Connectors are attached by nodeId/anchor, never coordinates — untouched.
  assert.deepEqual(result.connectors, [conn]);

  // Viewport/version untouched; node count and z-order (array order) untouched.
  assert.deepEqual(result.viewport, state.viewport);
  assert.equal(result.version, state.version);
  assert.equal(result.nodes.length, state.nodes.length);
  assert.deepEqual(result.nodes.map((n) => n.id), state.nodes.map((n) => n.id));

  // Original input state is not mutated.
  assert.deepEqual(state, before);
});

test("applyFrameMove: unknown frameId does not throw and leaves state effectively unchanged", () => {
  const f = frame({ id: "f1" });
  const state = emptyState({ nodes: [f] });
  assert.doesNotThrow(() => applyFrameMove(state, "nonexistent-frame", 10, 10));
  const result = applyFrameMove(state, "nonexistent-frame", 10, 10);
  assert.equal(result.nodes.find((n) => n.id === "f1")!.x, f.x);
});

// ---------------------------------------------------------------------------
// moveNodesBy (bonus coverage — documented interface, propagates frame children)
// ---------------------------------------------------------------------------

test("moveNodesBy: moving a plain (non-frame) node moves only that node", () => {
  const a = rect({ id: "a", x: 0, y: 0 });
  const b = rect({ id: "b", x: 100, y: 100 });
  const state = emptyState({ nodes: [a, b] });
  const result = moveNodesBy(state, ["a"], 5, 7);
  assert.equal(result.nodes.find((n) => n.id === "a")!.x, 5);
  assert.equal(result.nodes.find((n) => n.id === "a")!.y, 7);
  assert.equal(result.nodes.find((n) => n.id === "b")!.x, 100);
  assert.equal(result.nodes.find((n) => n.id === "b")!.y, 100);
});

test("moveNodesBy: moving a frame id also propagates the delta to its children (matches applyFrameMove)", () => {
  const f = frame({ id: "f1", x: 0, y: 0 });
  const c1 = rect({ id: "c1", parentId: "f1", x: 10, y: 10 });
  const state = emptyState({ nodes: [f, c1] });
  const result = moveNodesBy(state, ["f1"], 8, 3);
  assert.equal(result.nodes.find((n) => n.id === "f1")!.x, 8);
  assert.equal(result.nodes.find((n) => n.id === "c1")!.x, 18);
  assert.equal(result.nodes.find((n) => n.id === "c1")!.y, 13);
});

test("moveNodesBy: a frame and its own child both explicitly selected still move by exactly one delta each, never double-applied", () => {
  const f = frame({ id: "f1", x: 0, y: 0 });
  const c1 = rect({ id: "c1", parentId: "f1", x: 10, y: 10 });
  const state = emptyState({ nodes: [f, c1] });
  const result = moveNodesBy(state, ["f1", "c1"], 10, 10);
  assert.equal(result.nodes.find((n) => n.id === "c1")!.x, 20, "must be +10 once, not +20");
  assert.equal(result.nodes.find((n) => n.id === "c1")!.y, 20, "must be +10 once, not +20");
});

// ---------------------------------------------------------------------------
// resizeNode — keep-aspect vs free-resize math
// (Assumption: compass-corner handle strings "se"/"nw"; see file header.)
// ---------------------------------------------------------------------------

test("resizeNode: free resize (keepAspect=false) from the 'se' handle grows w/h and leaves the origin fixed", () => {
  const n = rect({ x: 0, y: 0, w: 100, h: 50 });
  const result = resizeNode(n, "se", 20, 10, false);
  assert.equal(result.x, 0);
  assert.equal(result.y, 0);
  assert.equal(result.w, 120);
  assert.equal(result.h, 60);
});

test("resizeNode: free resize (keepAspect=false) from the 'nw' handle shifts the origin and shrinks/grows w/h inversely", () => {
  const n = rect({ x: 0, y: 0, w: 100, h: 50 });
  const result = resizeNode(n, "nw", 10, 5, false);
  assert.equal(result.x, 10);
  assert.equal(result.y, 5);
  assert.equal(result.w, 90);
  assert.equal(result.h, 45);
});

test("resizeNode: keepAspect=true with only a horizontal delta scales height to preserve the original aspect ratio", () => {
  const n = rect({ x: 0, y: 0, w: 100, h: 50 }); // aspect 2:1
  const result = resizeNode(n, "se", 40, 0, true);
  assert.equal(result.w, 140);
  closeTo(result.h, 70); // 140 / 2 = 70
});

test("resizeNode: keepAspect=true with only a vertical delta scales width to preserve the original aspect ratio", () => {
  const n = rect({ x: 0, y: 0, w: 100, h: 50 }); // aspect 2:1
  const result = resizeNode(n, "se", 0, 25, true);
  assert.equal(result.h, 75);
  closeTo(result.w, 150); // 75 * 2 = 150
});

test("resizeNode: does not mutate the input node and preserves unrelated fields (fill/stroke/strokeWidth)", () => {
  const n = rect({ x: 0, y: 0, w: 100, h: 50, fill: "#123456", stroke: "#abcdef", strokeWidth: 3 });
  const before = JSON.parse(JSON.stringify(n));
  const result = resizeNode(n, "se", 20, 20, false);
  assert.deepEqual(n, before, "input node must not be mutated");
  assert.equal((result as ShapeNode).fill, "#123456");
  assert.equal((result as ShapeNode).stroke, "#abcdef");
  assert.equal((result as ShapeNode).strokeWidth, 3);
});

// ---------------------------------------------------------------------------
// marqueeHits
// ---------------------------------------------------------------------------

test("marqueeHits: a node fully inside the marquee rect is returned", () => {
  const inside = rect({ id: "inside", x: 10, y: 10, w: 20, h: 20 });
  const state = emptyState({ nodes: [inside] });
  const hits = marqueeHits(state, { x: 0, y: 0, w: 100, h: 100 });
  assert.deepEqual(hits, ["inside"]);
});

test("marqueeHits: a node fully outside the marquee rect is not returned", () => {
  const outside = rect({ id: "outside", x: 500, y: 500, w: 20, h: 20 });
  const state = emptyState({ nodes: [outside] });
  const hits = marqueeHits(state, { x: 0, y: 0, w: 100, h: 100 });
  assert.deepEqual(hits, []);
});

test("marqueeHits: a node partially overlapping the marquee rect (straddling its boundary) is returned", () => {
  const straddling = rect({ id: "straddle", x: 80, y: 80, w: 40, h: 40 }); // rect spans (80,80)-(120,120); marquee (0,0)-(100,100)
  const state = emptyState({ nodes: [straddling] });
  const hits = marqueeHits(state, { x: 0, y: 0, w: 100, h: 100 });
  assert.deepEqual(hits, ["straddle"]);
});

test("marqueeHits: mixed set returns exactly the fully/partially intersecting nodes, in any order", () => {
  const a = rect({ id: "a", x: 10, y: 10, w: 10, h: 10 }); // fully inside
  const b = rect({ id: "b", x: 90, y: 90, w: 40, h: 40 }); // straddling
  const c = rect({ id: "c", x: 1000, y: 1000, w: 10, h: 10 }); // outside
  const f = frame({ id: "f", x: 20, y: 20, w: 10, h: 10 }); // frame nodes count too
  const state = emptyState({ nodes: [a, b, c, f] });
  const hits = marqueeHits(state, { x: 0, y: 0, w: 100, h: 100 }).slice().sort();
  assert.deepEqual(hits, ["a", "b", "f"].sort());
});

test("marqueeHits: an empty/non-intersecting rect returns an empty array", () => {
  const a = rect({ id: "a", x: 500, y: 500, w: 10, h: 10 });
  const state = emptyState({ nodes: [a] });
  assert.deepEqual(marqueeHits(state, { x: 0, y: 0, w: 5, h: 5 }), []);
});

// ---------------------------------------------------------------------------
// connectorPath
// ---------------------------------------------------------------------------

function parseMoveTo(d: string): { x: number; y: number } | null {
  const m = /[Mm]\s*(-?[\d.]+)[,\s]+(-?[\d.]+)/.exec(d);
  if (!m) return null;
  return { x: parseFloat(m[1]), y: parseFloat(m[2]) };
}

test("connectorPath: free-to-free connector produces a non-empty, stable SVG path string", () => {
  const conn: Connector = {
    id: "c1",
    from: { x: 0, y: 0 },
    to: { x: 100, y: 100 },
    kind: "line",
    stroke: "#000",
    strokeWidth: 1,
  };
  const d1 = connectorPath(conn, {});
  const d2 = connectorPath(conn, {});
  assert.equal(typeof d1, "string");
  assert.ok(d1.length > 0);
  assert.equal(d1, d2, "must be deterministic/stable for identical input");
});

test("connectorPath: attached-to-attached connector with fixed (non-auto) anchors is stable and non-crashing", () => {
  const a = rect({ id: "a", x: 0, y: 0, w: 50, h: 50 });
  const b = rect({ id: "b", x: 200, y: 0, w: 50, h: 50 });
  const nodesById = byId([a, b]);
  const conn: Connector = {
    id: "c1",
    from: { nodeId: "a", anchor: "right" },
    to: { nodeId: "b", anchor: "left" },
    kind: "arrow",
    stroke: "#000",
    strokeWidth: 1,
  };
  const d1 = connectorPath(conn, nodesById);
  const d2 = connectorPath(conn, nodesById);
  assert.ok(d1.length > 0);
  assert.equal(d1, d2);
});

test("connectorPath: anchor 'auto' resolves toward the perimeter point nearest the opposite endpoint", () => {
  const a = rect({ id: "a", x: 0, y: 0, w: 50, h: 50 }); // right edge at x=50
  const b = rect({ id: "b", x: 500, y: 0, w: 50, h: 50 }); // far to the right of A
  const nodesById = byId([a, b]);
  const conn: Connector = {
    id: "c1",
    from: { nodeId: "a", anchor: "auto" },
    to: { nodeId: "b", anchor: "center" },
    kind: "line",
    stroke: "#000",
    strokeWidth: 1,
  };
  const d = connectorPath(conn, nodesById);
  const start = parseMoveTo(d);
  assert.ok(start, `expected a parsable M/m command in path: ${d}`);
  // B is far to A's right, so the nearest point on A's perimeter should be
  // toward A's right edge (x close to 50), not A's left edge (x close to 0).
  assert.ok(start!.x > 25, `expected auto anchor to lean toward A's right edge, got x=${start!.x} in "${d}"`);
});

test("connectorPath: a connector referencing a nonexistent nodeId does not throw", () => {
  const conn: Connector = {
    id: "c1",
    from: { nodeId: "does-not-exist", anchor: "center" },
    to: { x: 10, y: 10 },
    kind: "line",
    stroke: "#000",
    strokeWidth: 1,
  };
  assert.doesNotThrow(() => connectorPath(conn, {}));
  const d = connectorPath(conn, {});
  assert.equal(typeof d, "string");
});

// ---------------------------------------------------------------------------
// hitTest (bonus coverage — documented interface: "top-most node id")
// ---------------------------------------------------------------------------

test("hitTest: returns the id of the node under the point when exactly one node is there", () => {
  const a = rect({ id: "a", x: 0, y: 0, w: 50, h: 50 });
  const state = emptyState({ nodes: [a] });
  assert.equal(hitTest(state, { x: 25, y: 25 }), "a");
});

test("hitTest: returns null when no node is under the point", () => {
  const a = rect({ id: "a", x: 0, y: 0, w: 50, h: 50 });
  const state = emptyState({ nodes: [a] });
  assert.equal(hitTest(state, { x: 1000, y: 1000 }), null);
});

test("hitTest: overlapping nodes — the front-most (highest array index) node wins", () => {
  const back = rect({ id: "back", x: 0, y: 0, w: 100, h: 100 });
  const front = rect({ id: "front", x: 0, y: 0, w: 100, h: 100 });
  const state = emptyState({ nodes: [back, front] });
  assert.equal(hitTest(state, { x: 50, y: 50 }), "front");
});
