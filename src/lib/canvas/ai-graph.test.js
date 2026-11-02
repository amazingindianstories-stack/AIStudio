import assert from "node:assert/strict";
import test from "node:test";
import { STICKY_FILLS, applyCluster, applyRecolor, applyRewrite, colorPatch, diagramGraph, layoutGraph, rankNodes, summaryGraph } from "./ai-graph.js";
import { validateCanvasState } from "./serialization.js";

const C = { x: 0, y: 0 };
const flow = {
  kind: "flowchart",
  nodes: [{ id: "a", label: "Start", shape: "ellipse" }, { id: "b", label: "Review" }, { id: "c", label: "Done" }],
  edges: [{ from: "a", to: "b", label: "submit" }, { from: "b", to: "c" }, { from: "b", to: "zzz" }],
};

test("rank follows the edges from the roots and survives cycles", () => {
  const rank = rankNodes(flow.nodes, flow.edges.slice(0, 2));
  assert.deepEqual([rank.get("a"), rank.get("b"), rank.get("c")], [0, 1, 2]);
  const cycle = rankNodes([{ id: "x" }, { id: "y" }], [{ from: "x", to: "y" }, { from: "y", to: "x" }]);
  assert.equal(cycle.get("x"), 0);
});

test("a diagram becomes shapes and connectors, dropping edges to unknown nodes", () => {
  const { nodes, connectors } = diagramGraph(flow, C);
  assert.equal(nodes.length, 3);
  assert.equal(connectors.length, 2);
  assert.ok(nodes[1].y > nodes[0].y, "a flowchart reads top to bottom");
  const ids = new Set(nodes.map((node) => node.id));
  assert.ok(connectors.every((connector) => ids.has(connector.from.nodeId) && ids.has(connector.to.nodeId)));
  assert.equal(connectors[0].labels[0].text, "submit");
  const mind = diagramGraph({ ...flow, kind: "mindmap" }, C);
  assert.ok(mind.nodes[1].x > mind.nodes[0].x, "a mind map reads left to right");
  assert.deepEqual(diagramGraph({ nodes: [] }, C), { nodes: [], connectors: [] });
});

test("layout notes take the requested colour, with readable text on black", () => {
  const { nodes } = layoutGraph({ title: "Plan", frames: [{ title: "Prep", notes: [{ text: "a", color: "black" }, { text: "b", color: "yellow", fill: "#00ff88" }] }] }, C);
  const stickies = nodes.filter((node) => node.type === "sticky");
  assert.deepEqual(stickies.map((node) => [node.fill, node.color]), [["#1a1a1a", "#f5f5f5"], ["#00ff88", "#1c1a12"]]);
});

test("a recolour result recolours the selected notes through the same colour rules as a Sidekick update, skipping locked ones", () => {
  const note = (id, extra = {}) => ({ id, type: "sticky", x: 0, y: 0, w: 200, h: 200, text: id, fill: STICKY_FILLS.yellow, fontSize: 16, color: "#1c1a12", opacity: 1, parentId: null, groupId: null, ...extra });
  const present = { nodes: [note("a"), note("b"), note("c", { locked: true }), { id: "t", type: "text", x: 0, y: 0, w: 10, h: 10, text: "t" }], connectors: [] };
  const { present: next, touched } = applyRecolor(present, { items: [{ id: "a", color: "black", fill: "" }, { id: "b", color: "yellow", fill: "#00FF88" }, { id: "c", color: "red", fill: "" },
    { id: "t", color: "red", fill: "" }, { id: "gone", color: "red", fill: "" }] }, 7);
  assert.deepEqual(touched, ["a", "b"]);
  assert.deepEqual(next.nodes.map((node) => [node.fill, node.color, node.aiEditedAt]),
    [["#1a1a1a", "#f5f5f5", 7], ["#00ff88", "#1c1a12", 7], [STICKY_FILLS.yellow, "#1c1a12", undefined], [undefined, undefined, undefined]]);
  assert.deepEqual(colorPatch({ type: "sticky", fill: "#fff" }, { color: "teal" }), { fill: STICKY_FILLS.teal, color: "#1c1a12" });
  assert.deepEqual(colorPatch({ type: "rect", fill: "#fff" }, { fill: "#112233" }), { fill: "#112233", color: "#f5f5f5" });
  assert.deepEqual(colorPatch({ type: "shape", shape: "star", fill: "rgba(255,255,255,0.06)" }, { color: "white" }), { fill: STICKY_FILLS.white, color: "#1c1a12" },
    "a shape with no text colour of its own (white) gets dark text on a light fill");
  assert.deepEqual(colorPatch({ type: "frame", fill: "transparent" }, { color: "red" }), {});
  assert.deepEqual(colorPatch({ type: "sticky", fill: "#fff" }, {}), {});
});

test("a layout is a title, frames side by side, and stickies parented to their frame", () => {
  const { nodes } = layoutGraph({ title: "Plan", frames: [{ title: "Prep", notes: [{ text: "a" }, { text: "b" }] }, { title: "Shoot", notes: [{ text: "c" }] }] }, C);
  const frames = nodes.filter((node) => node.type === "frame");
  assert.equal(frames.length, 2);
  assert.ok(frames[1].x > frames[0].x + frames[0].w);
  const stickies = nodes.filter((node) => node.type === "sticky");
  assert.equal(stickies.length, 3);
  assert.equal(stickies[0].parentId, frames[0].id);
  assert.equal(stickies[2].parentId, frames[1].id);
  assert.ok(nodes.some((node) => node.type === "text" && node.text === "Plan"));
});

const present = {
  nodes: [
    { id: "s1", type: "sticky", x: 0, y: 0, w: 200, h: 200, text: "teh cat", marks: [1] },
    { id: "s2", type: "sticky", x: 300, y: 0, w: 200, h: 200, text: "dog", locked: true },
    { id: "f1", type: "frame", x: 0, y: 400, w: 300, h: 300, name: "Frme" },
  ],
  connectors: [],
};

test("a rewrite edits only changed, unlocked objects, drops marks and renames frames", () => {
  const { present: next, touched } = applyRewrite(present, { items: [{ id: "s1", text: "the cat" }, { id: "s2", text: "hound" }, { id: "f1", text: "Frame" }, { id: "nope", text: "x" }] });
  assert.deepEqual(touched, ["s1", "f1"]);
  assert.equal(next.nodes[0].text, "the cat");
  assert.equal("marks" in next.nodes[0], false);
  assert.equal(next.nodes[1].text, "dog");
  assert.equal(next.nodes[2].name, "Frame");
  assert.equal(applyRewrite(present, { items: [{ id: "s1", text: "teh cat" }] }).touched.length, 0);
});

test("clustering moves unlocked stickies into titled columns", () => {
  const { present: next, touched } = applyCluster(present, { groups: [{ title: "Pets", ids: ["s1", "s2", "f1"] }] });
  assert.equal(next.nodes.length, present.nodes.length + 1);
  assert.equal(next.nodes.find((node) => node.id === "s2").x, 300, "locked stickies stay put");
  assert.ok(touched.includes("s1") && !touched.includes("s2"));
  assert.ok(next.nodes.some((node) => node.type === "text" && node.text === "Pets"));
  assert.equal(applyCluster(present, { groups: [] }).touched.length, 0);
});

test("placing the same cluster twice leaves one title per group", () => {
  const result = { groups: [{ title: "Pets", ids: ["s1"] }, { title: "Things", ids: ["s3"] }] };
  const board = { nodes: [
    { id: "s1", type: "sticky", x: 0, y: 0, w: 200, h: 200, text: "cat" },
    { id: "s3", type: "sticky", x: 600, y: 300, w: 200, h: 200, text: "lamp" },
  ] };
  const once = applyCluster(board, result).present;
  const twice = applyCluster(once, result);
  const titles = (state) => state.nodes.filter((node) => node.type === "text").map((node) => node.text).sort();
  assert.deepEqual(titles(once), ["Pets", "Things"]);
  assert.deepEqual(titles(twice.present), ["Pets", "Things"]);
  assert.deepEqual(twice.present.nodes, once.nodes);
  assert.equal(twice.touched.length, 4);
});

test("a summary is one note to the right of the selection and nodes validate as board content", () => {
  const { nodes } = summaryGraph({ title: "Recap", body: "Points" }, present, ["s1", "s2"], C);
  assert.equal(nodes.length, 1);
  assert.ok(nodes[0].x >= 500);
  assert.match(nodes[0].text, /Recap/);
  const graph = diagramGraph(flow, C);
  const checked = validateCanvasState({ version: 1, nodes: graph.nodes, connectors: graph.connectors });
  assert.ok(checked, "generated diagram objects are valid board objects");
});

test("edits skip objects on a locked layer and texts the AI only saw part of", () => {
  const board = {
    settings: { layers: [{ id: "L1", name: "Locked", locked: true }] },
    nodes: [
      { id: "a", type: "sticky", x: 0, y: 0, w: 200, h: 200, text: "teh cat", layerId: "L1" },
      { id: "b", type: "sticky", x: 300, y: 0, w: 200, h: 200, text: "x".repeat(2500) },
      { id: "c", type: "sticky", x: 600, y: 0, w: 200, h: 200, text: "teh dog" },
    ],
  };
  const items = [{ id: "a", text: "the cat" }, { id: "b", text: "short" }, { id: "c", text: "the dog" }];
  assert.deepEqual(applyRewrite(board, { items }).touched, ["c"]);
  const clustered = applyCluster(board, { groups: [{ title: "All", ids: ["a", "c"] }] });
  assert.deepEqual(clustered.touched.filter((id) => ["a", "c"].includes(id)), ["c"]);
});

test("a refined summary takes the place of the note it refines", () => {
  const { nodes } = summaryGraph({ title: "Recap", body: "Points" }, present, ["s1"], { x: 1000, y: 1000 }, true);
  assert.equal(nodes[0].x + nodes[0].w / 2, 1000);
  assert.equal(nodes[0].y + nodes[0].h / 2, 1000);
});
