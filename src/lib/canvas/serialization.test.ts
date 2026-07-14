/**
 * Unit tests for src/lib/canvas/serialization.ts — emptyCanvasState() and
 * validateCanvasState(), the defensive load/migration boundary for board
 * JSON (design.md: "Corrupt stored blob -> validateCanvasState coerces/
 * defaults rather than crashing (so one bad board can't white-screen the
 * app)"; spec.md AC #9 persistence round-trip fidelity).
 *
 * Derived independently from design.md's Data model and Interfaces sections,
 * BEFORE reading any implementation. Pure module: no DOM, no network. Run:
 *   npx tsx --test src/lib/canvas/serialization.test.ts
 *
 * Interpreted ambiguity: design.md's Risks section says validateCanvasState
 * "CAN additionally reject data:-prefixed src on save" — phrased as an
 * optional hardening, not a firm contract — so no test here asserts that
 * specific behavior as required. See final report.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { emptyCanvasState, validateCanvasState } from "./serialization";
import { CANVAS_STATE_VERSION } from "./types";
import type {
  CanvasState,
  ShapeNode,
  TextNode,
  StickyNode,
  FrameNode,
  ImageNode,
  Connector,
} from "./types";

// ---------------------------------------------------------------------------
// emptyCanvasState
// ---------------------------------------------------------------------------

test("emptyCanvasState: returns the current CANVAS_STATE_VERSION", () => {
  const state = emptyCanvasState();
  assert.equal(state.version, CANVAS_STATE_VERSION);
});

test("emptyCanvasState: returns the identity/zero viewport {x:0,y:0,zoom:1}", () => {
  const state = emptyCanvasState();
  assert.deepEqual(state.viewport, { x: 0, y: 0, zoom: 1 });
});

test("emptyCanvasState: returns empty nodes and connectors arrays", () => {
  const state = emptyCanvasState();
  assert.deepEqual(state.nodes, []);
  assert.deepEqual(state.connectors, []);
});

test("emptyCanvasState: successive calls return independent array instances (mutating one does not affect another)", () => {
  const a = emptyCanvasState();
  const b = emptyCanvasState();
  a.nodes.push({} as ShapeNode);
  assert.equal(b.nodes.length, 0, "b.nodes must not be affected by mutating a.nodes");
});

// ---------------------------------------------------------------------------
// validateCanvasState — full round trip
// ---------------------------------------------------------------------------

function buildFullState(): CanvasState {
  const rectNode: ShapeNode = {
    id: "rect1",
    type: "rect",
    x: 0,
    y: 0,
    w: 100,
    h: 50,
    opacity: 1,
    parentId: null,
    groupId: null,
    fill: "#ff0000",
    stroke: "#000000",
    strokeWidth: 2,
    cornerRadius: 4,
  };
  const ellipseNode: ShapeNode = {
    id: "ellipse1",
    type: "ellipse",
    x: 200,
    y: 0,
    w: 80,
    h: 80,
    opacity: 0.8,
    parentId: null,
    groupId: "group1",
    fill: "#00ff00",
    stroke: "#111111",
    strokeWidth: 1,
  };
  const triangleNode: ShapeNode = {
    id: "triangle1",
    type: "triangle",
    x: 300,
    y: 0,
    w: 60,
    h: 60,
    parentId: null,
    groupId: "group1",
    fill: "#0000ff",
    stroke: "#222222",
    strokeWidth: 1,
  };
  const diamondNode: ShapeNode = {
    id: "diamond1",
    type: "diamond",
    x: 400,
    y: 0,
    w: 60,
    h: 60,
    parentId: null,
    groupId: null,
    fill: "#ffff00",
    stroke: "#333333",
    strokeWidth: 1,
  };
  const textNode: TextNode = {
    id: "text1",
    type: "text",
    x: 0,
    y: 100,
    w: 150,
    h: 30,
    parentId: null,
    groupId: null,
    text: "Hello board",
    fontSize: 16,
    align: "left",
    color: "#000000",
  };
  const stickyNode: StickyNode = {
    id: "sticky1",
    type: "sticky",
    x: 0,
    y: 200,
    w: 120,
    h: 120,
    parentId: "frame1",
    groupId: null,
    text: "note text",
    fill: "#fff59d",
    fontSize: 14,
    color: "#000000",
  };
  const frameNode: FrameNode = {
    id: "frame1",
    type: "frame",
    x: -50,
    y: 150,
    w: 400,
    h: 300,
    parentId: null,
    groupId: null,
    name: "EXT. MOUNTAIN TOP - DAY",
    fill: "#f5f5f5",
    stroke: "#999999",
  };
  const imageNode: ImageNode = {
    id: "image1",
    type: "image",
    x: 500,
    y: 500,
    w: 320,
    h: 240,
    parentId: null,
    groupId: null,
    src: "/api/media/generations/abc123.png",
    alt: "generated image",
    aspectLocked: true,
    naturalW: 1024,
    naturalH: 768,
  };
  const connector: Connector = {
    id: "conn1",
    from: { nodeId: "rect1", anchor: "right" },
    to: { x: 999, y: 999 },
    kind: "arrow",
    stroke: "#000000",
    strokeWidth: 2,
    opacity: 1,
  };

  return {
    version: CANVAS_STATE_VERSION,
    viewport: { x: 12.5, y: -30, zoom: 1.75 },
    nodes: [
      frameNode,
      rectNode,
      ellipseNode,
      triangleNode,
      diamondNode,
      textNode,
      stickyNode,
      imageNode,
    ],
    connectors: [connector],
  };
}

test("validateCanvasState: round-trips a full hand-built CanvasState through JSON serialize -> parse with deep equality", () => {
  const original = buildFullState();
  const json = JSON.stringify(original);
  const parsed = JSON.parse(json);
  const validated = validateCanvasState(parsed);
  assert.deepEqual(validated, original);
});

test("validateCanvasState: preserves z-order (node array order) through the round trip", () => {
  const original = buildFullState();
  const validated = validateCanvasState(JSON.parse(JSON.stringify(original)));
  assert.deepEqual(
    validated.nodes.map((n) => n.id),
    original.nodes.map((n) => n.id)
  );
});

// ---------------------------------------------------------------------------
// validateCanvasState — defensive coercion on malformed input
// (the explicit "one bad board can't white-screen the app" requirement)
// ---------------------------------------------------------------------------

test("validateCanvasState: missing 'nodes' array is coerced to an empty array, not thrown", () => {
  const raw = { version: 1, viewport: { x: 0, y: 0, zoom: 1 }, connectors: [] };
  assert.doesNotThrow(() => validateCanvasState(raw));
  const result = validateCanvasState(raw);
  assert.ok(Array.isArray(result.nodes));
  assert.equal(result.nodes.length, 0);
});

test("validateCanvasState: missing 'connectors' array is coerced to an empty array, not thrown", () => {
  const raw = { version: 1, viewport: { x: 0, y: 0, zoom: 1 }, nodes: [] };
  assert.doesNotThrow(() => validateCanvasState(raw));
  const result = validateCanvasState(raw);
  assert.ok(Array.isArray(result.connectors));
  assert.equal(result.connectors.length, 0);
});

test("validateCanvasState: a node missing required fields does not throw and no surviving node has undefined core geometry", () => {
  const raw = {
    version: 1,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [
      { id: "broken", type: "rect" }, // missing x,y,w,h,fill,stroke,strokeWidth
      {
        id: "good",
        type: "rect",
        x: 0,
        y: 0,
        w: 10,
        h: 10,
        fill: "#fff",
        stroke: "#000",
        strokeWidth: 1,
      },
    ],
    connectors: [],
  };
  assert.doesNotThrow(() => validateCanvasState(raw));
  const result = validateCanvasState(raw);
  for (const n of result.nodes) {
    assert.notEqual(n.x, undefined, `node ${n.id} must have a defined x`);
    assert.notEqual(n.y, undefined, `node ${n.id} must have a defined y`);
    assert.notEqual(n.w, undefined, `node ${n.id} must have a defined w`);
    assert.notEqual(n.h, undefined, `node ${n.id} must have a defined h`);
    assert.equal(typeof n.x, "number");
    assert.equal(typeof n.y, "number");
    assert.equal(typeof n.w, "number");
    assert.equal(typeof n.h, "number");
  }
});

test("validateCanvasState: an unversioned blob ({nodes:[],connectors:[]}, no version/viewport) does not throw and produces a valid, versioned, viewport-complete state", () => {
  const raw = { nodes: [], connectors: [] };
  assert.doesNotThrow(() => validateCanvasState(raw));
  const result = validateCanvasState(raw);
  assert.equal(typeof result.version, "number");
  assert.equal(typeof result.viewport.x, "number");
  assert.equal(typeof result.viewport.y, "number");
  assert.equal(typeof result.viewport.zoom, "number");
  assert.ok(Array.isArray(result.nodes));
  assert.ok(Array.isArray(result.connectors));
});

test("validateCanvasState: completely garbage top-level inputs (null/undefined/string/number/array) never throw and always produce a well-formed empty-ish state", () => {
  const garbageInputs: unknown[] = [null, undefined, "not an object", 42, [], true, {}];
  for (const raw of garbageInputs) {
    assert.doesNotThrow(() => validateCanvasState(raw), `should not throw for input: ${JSON.stringify(raw)}`);
    const result = validateCanvasState(raw);
    assert.equal(typeof result.version, "number", `version for input: ${JSON.stringify(raw)}`);
    assert.ok(Array.isArray(result.nodes), `nodes for input: ${JSON.stringify(raw)}`);
    assert.ok(Array.isArray(result.connectors), `connectors for input: ${JSON.stringify(raw)}`);
    assert.equal(typeof result.viewport?.zoom, "number", `viewport.zoom for input: ${JSON.stringify(raw)}`);
  }
});

test("validateCanvasState: extra/unknown top-level and node-level keys do not throw and known valid data survives", () => {
  const raw = {
    version: 1,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [
      {
        id: "n1",
        type: "rect",
        x: 1,
        y: 2,
        w: 3,
        h: 4,
        fill: "#fff",
        stroke: "#000",
        strokeWidth: 1,
        someUnknownField: "should be ignored, not crash",
      },
    ],
    connectors: [],
    someTopLevelJunk: { nested: true },
  };
  assert.doesNotThrow(() => validateCanvasState(raw));
  const result = validateCanvasState(raw);
  const n1 = result.nodes.find((n) => n.id === "n1");
  assert.ok(n1, "the well-formed node must survive validation despite the stray extra key");
  assert.equal(n1!.x, 1);
  assert.equal(n1!.y, 2);
  assert.equal(n1!.w, 3);
  assert.equal(n1!.h, 4);
});

test("validateCanvasState: a completely malformed 'nodes' value (not an array) is coerced to an empty array rather than thrown", () => {
  const raw = { version: 1, viewport: { x: 0, y: 0, zoom: 1 }, nodes: "not-an-array", connectors: [] };
  assert.doesNotThrow(() => validateCanvasState(raw));
  const result = validateCanvasState(raw);
  assert.ok(Array.isArray(result.nodes));
});
