import assert from "node:assert/strict";
import test from "node:test";
import {
  alignDeltas,
  applyDeltas,
  arrangeUnits,
  autoLayoutBaseGap,
  autoLayoutDeltas,
  clearedNode,
  distributeDeltas,
  dominantAxis,
  duplicateOffset,
  idsOfKind,
  selectionKinds,
  unionBounds,
} from "./arrange.js";

const n = (id, x, y, w = 100, h = 100, extra = {}) => ({ id, type: "rect", x, y, w, h, parentId: null, groupId: null, ...extra });
const after = (state, deltas) => Object.fromEntries(applyDeltas(state, deltas).nodes.map((m) => [m.id, [m.x, m.y]]));

test("unionBounds", () => {
  assert.equal(unionBounds([]), null);
  assert.deepEqual(unionBounds([{ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: -5, w: 5, h: 5 }]), { x: 0, y: -5, w: 25, h: 15 });
});

test("units: locked objects are skipped and a group is one unit", () => {
  const state = { nodes: [n("a", 0, 0), n("g1", 200, 0, 50, 50, { groupId: "g" }), n("g2", 300, 100, 50, 50, { groupId: "g" }), n("l", 0, 500, 10, 10, { locked: true })] };
  const units = arrangeUnits(state, ["a", "g1", "g2", "l"]);
  assert.deepEqual(units, [
    { ids: ["a"], box: { x: 0, y: 0, w: 100, h: 100 } },
    { ids: ["g1", "g2"], box: { x: 200, y: 0, w: 150, h: 150 } },
  ]);
});

test("units skip objects on a locked layer", () => {
  const state = { nodes: [n("a", 0, 0, 10, 10, { layerId: "L" }), n("b", 50, 0)], settings: { layers: [{ id: "L", locked: true }] } };
  assert.deepEqual(arrangeUnits(state, ["a", "b"]).map((u) => u.ids), [["b"]]);
});

test("align left/right/centers moves each unit to the selection's edge", () => {
  const state = { nodes: [n("a", 0, 0, 100, 100), n("b", 50, 200, 20, 40)] };
  assert.deepEqual(after(state, alignDeltas(state, ["a", "b"], "left")), { a: [0, 0], b: [0, 200] });
  assert.deepEqual(after(state, alignDeltas(state, ["a", "b"], "right")), { a: [0, 0], b: [80, 200] });
  assert.deepEqual(after(state, alignDeltas(state, ["a", "b"], "hcenter")), { a: [0, 0], b: [40, 200] });
  assert.deepEqual(after(state, alignDeltas(state, ["a", "b"], "top")), { a: [0, 0], b: [50, 0] });
  assert.deepEqual(after(state, alignDeltas(state, ["a", "b"], "bottom")), { a: [0, 140], b: [50, 200] });
  assert.deepEqual(after(state, alignDeltas(state, ["a", "b"], "vcenter")), { a: [0, 70], b: [50, 100] });
});

test("align needs two movable units and ignores a locked one entirely", () => {
  const state = { nodes: [n("a", 0, 0), n("b", 50, 200), n("lock", -500, 0, 10, 10, { locked: true })] };
  // The locked node is far left but is not the target edge.
  assert.deepEqual(after(state, alignDeltas(state, ["a", "b", "lock"], "left")), { a: [0, 0], b: [0, 200], lock: [-500, 0] });
  assert.equal(alignDeltas(state, ["a", "lock"], "left").size, 0);
  assert.equal(alignDeltas(state, ["a", "b"], "diagonal").size, 0);
});

test("a group aligns as one box and keeps its layout", () => {
  const state = { nodes: [n("a", 0, 0), n("g1", 200, 10, 50, 50, { groupId: "g" }), n("g2", 300, 10, 50, 50, { groupId: "g" })] };
  assert.deepEqual(after(state, alignDeltas(state, ["a", "g1", "g2"], "left")), { a: [0, 0], g1: [0, 10], g2: [100, 10] });
});

test("distribute spaces 3+ units evenly between the outermost two", () => {
  const state = { nodes: [n("a", 0, 0, 100, 10), n("b", 120, 50, 50, 10), n("c", 400, 0, 100, 10)] };
  // Span 0..500, sizes 250, gap (500-250)/2 = 125: b at 225.
  assert.deepEqual(after(state, distributeDeltas(state, ["c", "a", "b"], "x")), { a: [0, 0], b: [225, 50], c: [400, 0] });
  assert.equal(distributeDeltas(state, ["a", "b"], "x").size, 0);
  const col = { nodes: [n("a", 0, 0, 10, 100), n("b", 0, 300, 10, 100), n("c", 0, 110, 10, 100)] };
  assert.deepEqual(after(col, distributeDeltas(col, ["a", "b", "c"], "y")), { a: [0, 0], b: [0, 300], c: [0, 150] });
});

test("auto layout lines units up in a row or column with the chosen gap", () => {
  const state = { nodes: [n("a", 0, 0, 100, 50), n("b", 300, 40, 50, 50), n("c", 150, 10, 50, 50)] };
  assert.equal(dominantAxis(state, ["a", "b", "c"]), "x");
  // Extent 0..350, sizes 200: base gap 75.
  assert.equal(autoLayoutBaseGap(state, ["a", "b", "c"], "x"), 75);
  assert.deepEqual(after(state, autoLayoutDeltas(state, ["a", "b", "c"], "x", 10)), { a: [0, 0], c: [110, 0], b: [170, 0] });
  assert.deepEqual(after(state, autoLayoutDeltas(state, ["a", "b", "c"], "y", 0)), { a: [0, 0], c: [0, 50], b: [0, 100] });
  // A negative gap clamps to touching.
  assert.deepEqual(after(state, autoLayoutDeltas(state, ["a", "c"], "x", -40)), { a: [0, 0], c: [100, 0], b: [300, 40] });
});

test("applyDeltas carries a frame's unselected children and re-parents moved objects", () => {
  const state = {
    nodes: [
      n("f", 0, 0, 200, 200, { type: "frame" }),
      n("child", 10, 10, 20, 20, { parentId: "f" }),
      n("lockedChild", 50, 50, 20, 20, { parentId: "f", locked: true }),
      n("f2", 1000, 0, 200, 200, { type: "frame" }),
      n("loose", 500, 500, 20, 20),
    ],
  };
  const out = applyDeltas(state, new Map([["f", { dx: 100, dy: 0 }], ["loose", { dx: 550, dy: -450 }]]));
  const byId = Object.fromEntries(out.nodes.map((m) => [m.id, m]));
  assert.equal(byId.child.x, 110);
  assert.equal(byId.lockedChild.x, 50);
  assert.equal(byId.loose.parentId, "f2");
  assert.equal(applyDeltas(state, new Map()), state);
});

test("smart duplicate lands beside the bounds with a 20 unit gap", () => {
  const b = { x: 0, y: 0, w: 100, h: 40 };
  assert.deepEqual(duplicateOffset(b, "right"), { dx: 120, dy: 0 });
  assert.deepEqual(duplicateOffset(b, "left"), { dx: -120, dy: 0 });
  assert.deepEqual(duplicateOffset(b, "down"), { dx: 0, dy: 60 });
  assert.deepEqual(duplicateOffset(b, "up"), { dx: 0, dy: -60 });
});

test("selection kinds count each type in a fixed order, every shape as a Shape", () => {
  const state = {
    nodes: [
      n("f", 0, 0, 10, 10, { type: "frame" }),
      n("s1", 0, 0, 10, 10, { type: "sticky" }),
      n("r", 0, 0, 10, 10, { type: "ellipse" }),
      n("sh", 0, 0, 10, 10, { type: "shape", shape: "star" }),
      n("t", 0, 0, 10, 10, { type: "text" }),
      n("i", 0, 0, 10, 10, { type: "image" }),
      n("s2", 0, 0, 10, 10, { type: "sticky" }),
    ],
  };
  const all = state.nodes.map((m) => m.id);
  assert.deepEqual(selectionKinds(state, all), [
    { kind: "sticky", label: "Sticky notes", count: 2 },
    { kind: "shape", label: "Shapes", count: 2 },
    { kind: "text", label: "Text", count: 1 },
    { kind: "image", label: "Images", count: 1 },
    { kind: "frame", label: "Frames", count: 1 },
  ]);
  assert.deepEqual(idsOfKind(state, ["s2", "r", "s1", "sh"], "shape"), ["r", "sh"]);
  assert.deepEqual(idsOfKind(state, ["s2", "r", "s1"], "sticky"), ["s2", "s1"]);
});

test("clearing content empties text and formatting but keeps the style", () => {
  const sticky = n("s", 0, 0, 10, 10, { type: "sticky", text: "Hello", marks: [[0, 5, "b"]], fill: "#fde68a", fontSize: 18 });
  const out = clearedNode(sticky);
  assert.equal(out.text, "");
  assert.equal("marks" in out, false);
  assert.equal(out.fill, "#fde68a");
  assert.equal(out.fontSize, 18);
  const empty = n("e", 0, 0, 10, 10, { type: "text", text: "" });
  assert.equal(clearedNode(empty), empty);
  const image = n("i", 0, 0, 10, 10, { type: "image", text: "caption?" });
  assert.equal(clearedNode(image), image);
});
