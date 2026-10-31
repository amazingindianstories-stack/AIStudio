import test from "node:test";
import assert from "node:assert/strict";

import {
  SHAPE_PACKS,
  filterShapePacks,
  loadEnabledPackIds,
  saveEnabledPackIds,
} from "./shape-packs.js";
import {
  calloutOutlineWithTail,
  isCalloutKind,
  isCreateTool,
  isShapeTool,
  registerCustomShapes,
  getCustomShapeByTool,
  shapeDetails,
  shapeOutline,
} from "./shapes.js";
import {
  DIAGRAM_THEMES,
  getDiagramTheme,
} from "./diagram-themes.js";
import {
  connectorPolyline,
  nearestTOnPolyline,
  pointAtPolyline,
  polylineEndTangents,
  polylineToPathWithJumps,
  snapPointToAngle,
} from "./connector-routing.js";
import {
  isContainerNode,
  moveNodesBy,
  nodeAnchorPoint,
  resolveEndpoint,
} from "./geometry.js";
import { validateCanvasState } from "./serialization.js";
import { cullBoard, hiddenBoardIds, hiddenDiagramLayerNodeIds } from "./culling.js";

test("Shape packs catalogue: includes Flowchart, Callouts, Diagram, UML, BPMN, DFD, VSM, Cloud, Electrical, Process", () => {
  const packIds = SHAPE_PACKS.map((p) => p.id);
  for (const expected of [
    "flowchart",
    "callouts",
    "structures",
    "uml",
    "bpmn",
    "dfd",
    "vsm",
    "cloud",
    "electrical",
    "process",
  ]) {
    assert.ok(packIds.includes(expected), `Missing pack: ${expected}`);
  }

  // Every shape in every pack has either a registered outline or is a structured tool
  for (const pack of SHAPE_PACKS) {
    assert.ok(pack.shapes.length > 0, `Pack ${pack.id} has no shapes`);
    for (const item of pack.shapes) {
      assert.ok(isCreateTool(item.tool), `Tool ${item.tool} in ${pack.id} is not a create tool`);
      assert.ok(isShapeTool(item.tool), `Tool ${item.tool} in ${pack.id} is not a shape tool`);
      if (item.tool.startsWith("shape:")) {
        const kind = item.tool.slice("shape:".length);
        const pts = shapeOutline(kind, 120, 90);
        assert.ok(Array.isArray(pts) && pts.length >= 3, `Outline for ${kind} invalid`);
        const details = shapeDetails(kind, 120, 90);
        assert.ok(Array.isArray(details), `Details for ${kind} should be an array`);
      }
    }
  }
});

test("Shape packs: search filtering and enable/disable persistence", () => {
  const filtered = filterShapePacks(SHAPE_PACKS, ["flowchart", "uml"], "database");
  // A search spans every pack, enabled or not; without a query only enabled packs list.
  assert.ok(filtered.length > 1);
  const flowchart = filtered.find((p) => p.id === "flowchart");
  assert.ok(flowchart.shapes.some((s) => s.tool === "shape:fc-database"));
  const listed = filterShapePacks(SHAPE_PACKS, ["flowchart", "uml"], "").map((p) => p.id);
  assert.deepEqual(listed, ["flowchart", "uml"]);

  const allDefaults = loadEnabledPackIds();
  assert.ok(allDefaults.includes("flowchart"));
  saveEnabledPackIds(["flowchart", "cloud-infra"]);
});

test("Callouts: dynamic tail outline tracks external world point", () => {
  assert.ok(isCalloutKind("callout"));
  assert.ok(isCalloutKind("callout-rect"));
  assert.ok(isCalloutKind("callout-oval"));
  assert.ok(isCalloutKind("callout-bracket"));
  assert.ok(!isCalloutKind("star"));

  const pts = calloutOutlineWithTail("callout-rect", 160, 120, { x: 240, y: 60 });
  assert.ok(pts.some(([x, y]) => x === 240 && y === 60), "Tail tip should reach (240, 60)");
});

test("Callouts: a moved tail keeps each kind's body shape and height", () => {
  const tip = { x: 300, y: 50 };
  const bodyOf = (kind) => {
    const pts = calloutOutlineWithTail(kind, 200, 100, tip);
    assert.deepEqual(pts.at(-1), [tip.x, tip.y]);
    return pts.slice(0, -1);
  };
  for (const [kind, bodyH] of [["callout", 78], ["callout-rect", 78], ["callout-oval", 80], ["callout-bracket", 82]]) {
    const ys = bodyOf(kind).map(([, y]) => y);
    assert.ok(Math.abs(Math.max(...ys) - bodyH) < 1e-6, `${kind} body ends at ${bodyH}`);
  }
  const oval = bodyOf("callout-oval");
  for (const [x, y] of oval) {
    const r = ((x - 100) / 100) ** 2 + ((y - 40) / 40) ** 2;
    assert.ok(r <= 1 + 1e-6, `oval point (${x}, ${y}) lies on or inside the ellipse`);
  }
  assert.ok(!bodyOf("callout").some(([x, y]) => x === 0 && y === 0), "rounded callout keeps rounded corners");
  assert.ok(bodyOf("callout-rect").some(([x, y]) => x === 0 && y === 0), "standard callout keeps its sharp corner");
});

test("Custom shape registry: registers and resolves custom SVG tools", () => {
  registerCustomShapes([
    {
      id: "pack-1",
      name: "My Pack",
      shapes: [{ id: "s-1", name: "Custom Valve", svg: '<path d="M0 0 L10 10"/>', viewBox: "0 0 24 24" }],
    },
  ]);
  const found = getCustomShapeByTool("custom-shape:pack-1:s-1");
  assert.ok(found);
  assert.equal(found.name, "Custom Valve");
  assert.equal(found.viewBox, "0 0 24 24");
});

test("Diagram themes: returns requested theme or falls back to default", () => {
  assert.ok(DIAGRAM_THEMES.length >= 6);
  const blueprint = getDiagramTheme("blueprint");
  assert.equal(blueprint.id, "blueprint");
  assert.equal(getDiagramTheme("unknown-id").id, "default");
});

test("ERD row-level anchors and container movement", () => {
  const erd = {
    id: "erd-1",
    type: "erd",
    x: 100,
    y: 200,
    w: 240,
    h: 160,
    name: "users",
    fill: "#18181b",
    stroke: "#6366f1",
    strokeWidth: 2,
    columns: 3,
    rows: [
      { id: "r1", cells: ["PK", "id", "uuid"] },
      { id: "r2", cells: ["FK", "team_id", "uuid"] },
    ],
    parentId: null,
    groupId: null,
  };
  const leftPt = nodeAnchorPoint(erd, "row:r1:left");
  const rightPt = nodeAnchorPoint(erd, "row:r2:right");
  assert.equal(leftPt.x, 100);
  assert.equal(rightPt.x, 340);
  assert.ok(rightPt.y > leftPt.y);

  const nodesById = { "erd-1": erd };
  const resolved = resolveEndpoint({ nodeId: "erd-1", anchor: "row:r2:right" }, nodesById);
  assert.deepEqual(resolved, rightPt);

  // Rows are drawn 28px tall under the 2px border and 36px header, whatever the box height.
  assert.equal(leftPt.y, 200 + 2 + 36 + 14);
  assert.equal(rightPt.y, 200 + 2 + 36 + 28 + 14);
  const taller = { ...erd, h: 400, rows: [...erd.rows, { id: "r3", cells: ["", "name", "text"] }] };
  assert.equal(nodeAnchorPoint(taller, "row:r3:left").y, 200 + 2 + 36 + 56 + 14);
  assert.equal(nodeAnchorPoint({ ...taller, strokeWidth: 4 }, "row:r1:left").y, 200 + 4 + 36 + 14);
});

test("Swimlanes and Diagrams move their child nodes when moved", () => {
  const swimlane = {
    id: "sw-1",
    type: "swimlane",
    x: 0,
    y: 0,
    w: 600,
    h: 400,
    name: "Pool",
    orientation: "horizontal",
    fill: "#111",
    stroke: "#444",
    strokeWidth: 2,
    lanes: [{ id: "l1", title: "Lane 1", size: 200 }],
    parentId: null,
    groupId: null,
  };
  const child = {
    id: "n-1",
    type: "rect",
    x: 50,
    y: 50,
    w: 100,
    h: 80,
    fill: "#222",
    stroke: "#fff",
    strokeWidth: 2,
    cornerRadius: 0,
    parentId: "sw-1",
    groupId: null,
  };
  assert.ok(isContainerNode(swimlane));
  const moved = moveNodesBy({ nodes: [swimlane, child], connectors: [], viewport: { x: 0, y: 0, zoom: 1 } }, ["sw-1"], 40, 30);
  const movedChild = moved.nodes.find((n) => n.id === "n-1");
  assert.equal(movedChild.x, 90);
  assert.equal(movedChild.y, 80);
});

test("Diagram layers: culling hides nodes on hidden diagram layers and their connectors", () => {
  const graph = {
    nodes: [
      {
        id: "diag-1",
        type: "diagram",
        x: 0,
        y: 0,
        w: 800,
        h: 600,
        name: "Arch",
        fill: "#111",
        stroke: "#6366f1",
        strokeWidth: 2,
        layers: [
          { id: "l-visible", name: "Core", visible: true },
          { id: "l-hidden", name: "Notes", visible: false },
        ],
        containers: [],
        parentId: null,
        groupId: null,
      },
      {
        id: "n-vis",
        type: "rect",
        x: 100,
        y: 100,
        w: 100,
        h: 80,
        fill: "#222",
        stroke: "#fff",
        strokeWidth: 2,
        cornerRadius: 0,
        parentId: "diag-1",
        diagramLayerId: "l-visible",
        groupId: null,
      },
      {
        id: "n-hid",
        type: "rect",
        x: 300,
        y: 100,
        w: 100,
        h: 80,
        fill: "#222",
        stroke: "#fff",
        strokeWidth: 2,
        cornerRadius: 0,
        parentId: "diag-1",
        diagramLayerId: "l-hidden",
        groupId: null,
      },
    ],
    connectors: [
      {
        id: "c-1",
        from: { nodeId: "n-vis", anchor: "right" },
        to: { nodeId: "n-hid", anchor: "left" },
        kind: "arrow",
        stroke: "#fff",
        strokeWidth: 2,
      },
    ],
  };
  const hiddenIds = hiddenDiagramLayerNodeIds(graph.nodes);
  assert.ok(hiddenIds.has("n-hid"));
  assert.ok(!hiddenIds.has("n-vis"));

  const nodesById = Object.fromEntries(graph.nodes.map((n) => [n.id, n]));
  const culled = cullBoard(graph, nodesById, { x: 0, y: 0, zoom: 1 }, { w: 1200, h: 800 });
  assert.ok(culled.nodes.some((n) => n.id === "n-vis"));
  assert.ok(!culled.nodes.some((n) => n.id === "n-hid"));
  assert.equal(culled.connectors.length, 0);
});

const box = (id, extra = {}) => ({ id, type: "rect", x: 0, y: 0, w: 40, h: 40, parentId: null, groupId: null, ...extra });
const diagram = (id, x, layers) => ({ ...box(id), type: "diagram", x, w: 400, h: 400, layers, containers: [] });

test("Diagram layers: a hidden layer hides only the nodes of its own diagram", () => {
  const nodes = [
    diagram("diag-a", 0, [{ id: "layer-main", name: "Main", visible: false }]),
    diagram("diag-b", 500, [{ id: "layer-main", name: "Main", visible: true }]),
    box("in-a", { parentId: "diag-a", diagramLayerId: "layer-main" }),
    box("group", { type: "frame", parentId: "diag-a" }),
    box("nested-a", { parentId: "group", diagramLayerId: "layer-main" }),
    box("in-b", { x: 520, parentId: "diag-b", diagramLayerId: "layer-main" }),
    box("loose", { x: 950, diagramLayerId: "layer-main" }),
  ];
  assert.deepEqual([...hiddenDiagramLayerNodeIds(nodes)].sort(), ["in-a", "nested-a"]);
});

test("Focus mode hides every node and connector outside the focused diagram", () => {
  const graph = {
    nodes: [
      diagram("diag-a", 0, []),
      box("in-a", { x: 20, y: 20, parentId: "diag-a" }),
      box("in-a-2", { x: 200, y: 200, parentId: "diag-a" }),
      box("placed-in-a", { x: 100, y: 300 }),
      diagram("diag-b", 500, []),
      box("in-b", { x: 520, parentId: "diag-b" }),
      box("loose", { x: 950 }),
    ],
    connectors: [
      { id: "inside", from: { nodeId: "in-a", anchor: "right" }, to: { nodeId: "in-a-2", anchor: "left" } },
      { id: "across", from: { nodeId: "in-a", anchor: "right" }, to: { nodeId: "in-b", anchor: "left" } },
      { id: "free-in", from: { nodeId: "in-a", anchor: "right" }, to: { x: 300, y: 300 } },
      { id: "free-out", from: { nodeId: "in-a", anchor: "right" }, to: { x: 450, y: 50 } },
    ],
  };
  const focused = hiddenBoardIds(graph, "diag-a");
  assert.deepEqual([...focused.nodes].sort(), ["diag-b", "in-b", "loose"]);
  assert.deepEqual([...focused.connectors].sort(), ["across", "free-out"]);

  const culled = cullBoard(graph, Object.fromEntries(graph.nodes.map((n) => [n.id, n])), { x: 0, y: 0, zoom: 1 }, { w: 2000, h: 1000 }, {}, focused);
  assert.deepEqual(culled.nodes.map((n) => n.id), ["diag-a", "in-a", "in-a-2", "placed-in-a"]);
  assert.deepEqual(culled.connectors.map((c) => c.id), ["inside", "free-in"]);

  for (const missing of [null, "in-a", "nope"]) {
    const none = hiddenBoardIds(graph, missing);
    assert.equal(none.nodes.size + none.connectors.size, 0, String(missing));
  }
});

test("Connector routing: Shift angle snap, orthogonal obstacle avoidance, line jumps, labels, tangents", () => {
  // 1. Shift angle snap (0, 45, 90 degrees)
  const snappedHoriz = snapPointToAngle({ x: 0, y: 0 }, { x: 100, y: 12 });
  assert.equal(snappedHoriz.y, 0);
  const snappedDiag = snapPointToAngle({ x: 0, y: 0 }, { x: 100, y: 95 });
  assert.ok(Math.abs(snappedDiag.x - snappedDiag.y) < 1e-4);

  // 2. Orthogonal routing around an obstacle node between start and end
  const nodesById = {
    a: { id: "a", type: "rect", x: 0, y: 100, w: 80, h: 80 },
    obstacle: { id: "obstacle", type: "rect", x: 150, y: 80, w: 100, h: 120 },
    b: { id: "b", type: "rect", x: 340, y: 100, w: 80, h: 80 },
  };
  const orthoConn = {
    id: "c-ortho",
    from: { nodeId: "a", anchor: "right" },
    to: { nodeId: "b", anchor: "left" },
    kind: "arrow",
    shape: "orthogonal",
    stroke: "#fff",
    strokeWidth: 2,
  };
  const poly = connectorPolyline(orthoConn, { x: 80, y: 140 }, { x: 340, y: 140 }, nodesById);
  assert.ok(poly.length >= 4, "Orthogonal route should bend around the obstacle");
  // Verify every segment is orthogonal (dx === 0 or dy === 0) and does not pass through obstacle center (200, 140)
  for (let i = 0; i < poly.length - 1; i++) {
    const p1 = poly[i];
    const p2 = poly[i + 1];
    assert.ok(
      Math.abs(p1.x - p2.x) < 1e-4 || Math.abs(p1.y - p2.y) < 1e-4,
      `Segment ${i} is not orthogonal`
    );
  }

  // 3. Line jumps: semicircular arc when crossing an earlier segment
  const jumpedPath = polylineToPathWithJumps(
    [
      { x: 0, y: 50 },
      { x: 100, y: 50 },
    ],
    [
      [
        { x: 50, y: 0 },
        { x: 50, y: 100 },
      ],
    ]
  );
  assert.ok(jumpedPath.includes(" A "), `Expected semicircular arc in path: ${jumpedPath}`);

  // 4. Labels along polyline and nearestT
  const mid = pointAtPolyline(
    [
      { x: 0, y: 0 },
      { x: 200, y: 0 },
    ],
    0.5
  );
  assert.equal(mid.x, 100);
  assert.equal(mid.y, 0);
  const t = nearestTOnPolyline(
    [
      { x: 0, y: 0 },
      { x: 200, y: 0 },
    ],
    { x: 150, y: 20 }
  );
  assert.ok(Math.abs(t - 0.75) < 0.02);

  // 5. End tangents
  const tangents = polylineEndTangents([
    { x: 0, y: 0 },
    { x: 100, y: 0 },
  ]);
  assert.equal(tangents.end.ux, 1);
  assert.equal(tangents.end.uy, 0);
});

test("Serialization round-trip: ERD, Swimlane, Diagram, Callout tail, and Connector caps/waypoints/labels", () => {
  const input = {
    version: 1,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [
      {
        id: "erd-1",
        type: "erd",
        x: 10,
        y: 20,
        w: 260,
        h: 160,
        name: "orders",
        fill: "#18181b",
        stroke: "#6366f1",
        strokeWidth: 2,
        strokeStyle: "dashed",
        headerFill: "#312e81",
        color: "#f4f4f5",
        columns: 3,
        rows: [{ id: "r1", cells: ["PK", "id", "uuid"] }],
        parentId: null,
        groupId: null,
      },
      {
        id: "sw-1",
        type: "swimlane",
        x: 300,
        y: 20,
        w: 600,
        h: 360,
        name: "Checkout Flow",
        orientation: "horizontal",
        fill: "#18181b",
        stroke: "#52525b",
        strokeWidth: 2,
        headerFill: "#3f3f46",
        color: "#fafafa",
        lanes: [{ id: "l1", name: "Customer", size: 180 }],
        parentId: null,
        groupId: null,
      },
      {
        id: "diag-1",
        type: "diagram",
        x: 0,
        y: 500,
        w: 640,
        h: 440,
        name: "Billing Diagram",
        fill: "#0f172a",
        stroke: "#6366f1",
        strokeWidth: 2,
        headerFill: "#1e1b4b",
        color: "#e0e7ff",
        layers: [{ id: "layer-1", name: "Core", visible: true }],
        containers: [{ id: "sub-1", name: "Sub", x: 20, y: 60, w: 200, h: 120, layerId: "layer-1" }],
        parentId: null,
        groupId: null,
      },
      {
        id: "call-1",
        type: "shape",
        shape: "callout-rect",
        x: 100,
        y: 300,
        w: 160,
        h: 120,
        fill: "#222",
        stroke: "#fff",
        strokeWidth: 2,
        strokeStyle: "dotted",
        cornerRadius: 12,
        tail: { nodeId: "erd-1", anchor: "bottom" },
        diagramLayerId: "layer-1",
        parentId: "diag-1",
        groupId: null,
      },
    ],
    connectors: [
      {
        id: "conn-1",
        from: { nodeId: "erd-1", anchor: "row:r1:right" },
        to: { nodeId: "call-1", anchor: "top" },
        kind: "arrow",
        shape: "orthogonal",
        stroke: "#fff",
        strokeWidth: 2,
        strokeStyle: "dashed",
        startCap: "erd-only-one",
        endCap: "erd-zero-or-many",
        waypoints: [{ x: 200, y: 250 }],
        labels: [{ id: "lbl-1", text: "1:N", position: 0.4, orientation: "aligned" }],
      },
    ],
  };

  const validated = validateCanvasState(input);
  assert.equal(validated.nodes.length, 4);
  assert.equal(validated.nodes[0].type, "erd");
  assert.equal(validated.nodes[0].strokeStyle, "dashed");
  assert.equal(validated.nodes[1].type, "swimlane");
  assert.equal(validated.nodes[2].type, "diagram");
  assert.equal(validated.nodes[3].strokeStyle, "dotted");
  assert.deepEqual(validated.nodes[3].tail, { nodeId: "erd-1", anchor: "bottom" });
  assert.equal(validated.connectors[0].shape, "orthogonal");
  assert.equal(validated.connectors[0].startCap, "erd-only-one");
  assert.equal(validated.connectors[0].endCap, "erd-zero-or-many");
  assert.equal(validated.connectors[0].waypoints.length, 1);
  assert.deepEqual(validated.connectors[0].labels, input.connectors[0].labels);
  for (const [index, node] of input.nodes.entries()) {
    for (const key of ["headerFill", "color", "lanes", "containers"]) {
      if (key in node) assert.deepEqual(validated.nodes[index][key], node[key], `${node.id}.${key}`);
    }
  }
  assert.deepEqual(validateCanvasState(validated), validated);
});
