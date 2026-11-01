import test from "node:test";
import assert from "node:assert/strict";
import { validateCanvasState } from "../serialization.js";
import { diagramToMermaid, layoutMermaid, mermaidToBoardObjects, parseMermaid, replaceDiagramContent } from "./mermaid.js";

test("flowchart nodes, shapes, chains and link labels", () => {
  const p = parseMermaid(`graph TD
  A[Start] --> B{Ready?}
  B -->|yes| C((Go))
  B -- no --> D(Wait) --> A
  C -.-> E([Done])`);
  assert.equal(p.ok, true);
  assert.deepEqual(p.nodes.map((n) => [n.id, n.shape, n.label]), [
    ["A", "rect", "Start"],
    ["B", "rhombus", "Ready?"],
    ["C", "circle", "Go"],
    ["D", "round", "Wait"],
    ["E", "stadium", "Done"],
  ]);
  assert.equal(p.edges.length, 5);
  assert.equal(p.edges[0].label, "");
  assert.equal(p.edges[1].label, "yes");
  assert.equal(p.edges[2].label, "no");
  assert.equal(p.edges[4].style, "dashed");
});

test("ampersand groups, plain lines and comments", () => {
  const p = parseMermaid("flowchart LR\n%% note\nA & B --> C\nC --- D");
  assert.equal(p.direction, "LR");
  assert.equal(p.edges.length, 3);
  assert.equal(p.edges[2].arrow, false);
  assert.equal(p.edges[2].line, true);
});

test("subgraphs group their nodes", () => {
  const p = parseMermaid("graph TB\nsubgraph one [First]\nA --> B\nend\nB --> C");
  assert.equal(p.groups[0].title, "First");
  assert.equal(p.nodes.find((n) => n.id === "A").group, "one");
  assert.equal(p.nodes.find((n) => n.id === "C").group, null);
});

test("state diagrams parse transitions with start and end markers", () => {
  const p = parseMermaid("stateDiagram-v2\n[*] --> Idle\nIdle --> Busy : work\nBusy --> [*]");
  assert.equal(p.ok, true);
  assert.equal(p.edges.length, 3);
  assert.equal(p.edges[1].label, "work");
  assert.ok(p.nodes.some((n) => n.label === "Start"));
});

test("unsupported or unsafe input is refused or reported, never evaluated", () => {
  assert.equal(parseMermaid("").ok, false);
  assert.match(parseMermaid("pie title x\n a : 1").error, /graph TD/);
  assert.equal(parseMermaid("graph TD\nA --> B\n???").warnings.length, 1);
  assert.equal(parseMermaid("x".repeat(20001)).ok, false);
  const lots = "graph TD\n" + Array.from({ length: 200 }, (_, i) => `N${i} --> N${i + 1}`).join("\n");
  assert.equal(parseMermaid(lots).ok, false);
  const p = parseMermaid('graph TD\nA["<img src=x onerror=alert(1)>hi"] --> B');
  assert.equal(p.nodes[0].label, "hi");
});

test("layout puts later layers further along the direction and handles cycles", () => {
  const p = parseMermaid("graph TD\nA --> B\nB --> C\nC --> A");
  const { positions } = layoutMermaid(p);
  assert.ok(positions.get("A").y < positions.get("B").y);
  assert.ok(positions.get("B").y < positions.get("C").y);
  const lr = layoutMermaid(parseMermaid("graph LR\nA --> B"));
  assert.ok(lr.positions.get("A").x < lr.positions.get("B").x);
  const rl = layoutMermaid(parseMermaid("graph RL\nA --> B"));
  assert.ok(rl.positions.get("A").x > rl.positions.get("B").x);
});

test("board objects are valid native nodes and connectors that keep their source", () => {
  const source = "graph TD\nA[One] -->|go| B{Two}";
  const built = mermaidToBoardObjects(parseMermaid(source), { x: 100, y: 200 }, { source });
  const state = validateCanvasState({ nodes: [built.diagram, ...built.nodes], connectors: built.connectors });
  assert.equal(state.nodes.length, 3);
  assert.equal(state.connectors.length, 1);
  assert.equal(state.nodes[0].source, source);
  assert.equal(state.nodes[0].sourceKind, "mermaid");
  assert.equal(state.connectors[0].labels[0].text, "go");
  assert.ok(state.nodes.slice(1).every((n) => n.parentId === built.diagram.id));
});

test("regenerating from edited text replaces the children and keeps the container", () => {
  const source = "graph TD\nA --> B";
  const built = mermaidToBoardObjects(parseMermaid(source), { x: 0, y: 0 }, { source, status: "draft" });
  const state = validateCanvasState({ nodes: [{ id: "keep", type: "rect", x: 0, y: 0, w: 5, h: 5 }, built.diagram, ...built.nodes], connectors: built.connectors });
  const next = replaceDiagramContent(state, built.diagram.id, parseMermaid("graph TD\nX --> Y --> Z"), "graph TD\nX --> Y --> Z");
  assert.equal(next.nodes.filter((n) => n.parentId === built.diagram.id).length, 3);
  assert.ok(next.nodes.some((n) => n.id === "keep"));
  assert.equal(next.connectors.length, 2);
  assert.equal(next.nodes.find((n) => n.id === built.diagram.id).status, "draft");
});

test("visual edits write back as Mermaid that parses to the same diagram", () => {
  const source = "graph TD\nA[One] -->|go| B{Two}\nB --> C((Three))";
  const built = mermaidToBoardObjects(parseMermaid(source), { x: 0, y: 0 }, { source });
  const state = validateCanvasState({ nodes: [built.diagram, ...built.nodes], connectors: built.connectors });
  const code = diagramToMermaid(state, built.diagram.id);
  const again = parseMermaid(code);
  assert.equal(again.ok, true);
  assert.deepEqual(again.nodes.map((n) => [n.label, n.shape]), [["One", "rect"], ["Two", "rhombus"], ["Three", "circle"]]);
  assert.equal(again.edges.length, 2);
  assert.equal(again.edges[0].label, "go");
});

test("reading visual edits into code keeps the diagram's direction", () => {
  const source = "flowchart LR\nA --> B --> C";
  const built = mermaidToBoardObjects(parseMermaid(source), { x: 0, y: 0 }, { source });
  const state = validateCanvasState({ nodes: [built.diagram, ...built.nodes], connectors: built.connectors });
  const code = diagramToMermaid(state, built.diagram.id);
  assert.match(code, /^flowchart LR\n/);
  const next = replaceDiagramContent(state, built.diagram.id, parseMermaid(code), code);
  const [a, b] = ["A", "B"].map((label) => next.nodes.find((n) => n.text === label));
  assert.ok(a.x < b.x);
  assert.equal(a.y, b.y);
});

test("updating from code keeps children and connectors the code does not describe", () => {
  const source = "graph TD\nA --> B";
  const built = mermaidToBoardObjects(parseMermaid(source), { x: 0, y: 0 }, { source });
  const [shapeA] = built.nodes;
  const image = { id: "img", type: "image", x: 10, y: 10, w: 40, h: 40, src: "https://example.test/a.png", parentId: built.diagram.id };
  const frame = { id: "screen", type: "frame", x: 60, y: 60, w: 80, h: 80, name: "Screen", parentId: built.diagram.id };
  const outside = { id: "outside", type: "rect", x: 900, y: 0, w: 50, h: 50 };
  const link = (id, from, to) => ({ id, from: { nodeId: from, anchor: "auto" }, to: { nodeId: to, anchor: "auto" } });
  const state = {
    nodes: [outside, built.diagram, ...built.nodes, image, frame],
    connectors: [...built.connectors, link("image-out", "img", "outside"), link("shape-out", shapeA.id, "outside")],
  };
  const next = replaceDiagramContent(state, built.diagram.id, parseMermaid("graph TD\nX --> Y --> Z"), "graph TD\nX --> Y --> Z");
  assert.deepEqual(next.nodes.find((n) => n.id === "img"), image);
  assert.deepEqual(next.nodes.find((n) => n.id === "screen"), frame);
  assert.ok(next.connectors.some((c) => c.id === "image-out"));
  assert.ok(!next.connectors.some((c) => c.id === "shape-out"));
  assert.ok(!next.nodes.some((n) => n.id === shapeA.id));
  assert.deepEqual(next.nodes.filter((n) => n.parentId === built.diagram.id && n.type === "rect").map((n) => n.text), ["X", "Y", "Z"]);
  assert.equal(next.connectors.length, 3);
});

test("updating from code keeps shapes whose key survives, with their connectors", () => {
  const source = "graph TD\nA --> B";
  const built = mermaidToBoardObjects(parseMermaid(source), { x: 0, y: 0 }, { source });
  const [shapeA] = built.nodes;
  const outside = { id: "outside", type: "sticky", x: 900, y: 0, w: 50, h: 50 };
  const image = { id: "img", type: "image", x: 10, y: 10, w: 40, h: 40, src: "/api/media/a.png", parentId: built.diagram.id };
  const drawn = { id: "drawn", type: "rect", x: 20, y: 20, w: 40, h: 40, text: "Mine", parentId: built.diagram.id };
  const link = (id, from, to) => ({ id, from: { nodeId: from, anchor: "auto" }, to: { nodeId: to, anchor: "auto" } });
  const state = validateCanvasState({
    nodes: [outside, built.diagram, ...built.nodes, image, drawn],
    connectors: [...built.connectors, link("a-out", shapeA.id, "outside"), link("a-img", shapeA.id, "img")],
  });
  const code = "graph TD\nA --> B --> C";
  const next = replaceDiagramContent(state, built.diagram.id, parseMermaid(code), code);
  assert.equal(next.nodes.find((n) => n.mermaidKey === "A").id, shapeA.id);
  assert.ok(next.connectors.some((c) => c.id === "a-out"));
  assert.ok(next.connectors.some((c) => c.id === "a-img"));
  assert.ok(next.nodes.some((n) => n.id === "drawn"));
  assert.deepEqual(next.nodes.filter((n) => n.mermaidKey).map((n) => n.text), ["A", "B", "C"]);
  assert.equal(next.connectors.length, 4);
});

test("shapes drawn into a diagram join the code once read, keeping their identity", () => {
  const source = "graph TD\nA --> B";
  const built = mermaidToBoardObjects(parseMermaid(source), { x: 0, y: 0 }, { source });
  const [shapeA] = built.nodes;
  const drawn = { id: "drawn-1", type: "rect", x: 20, y: 20, w: 40, h: 40, text: "Mine", parentId: built.diagram.id };
  const copy = { ...shapeA, id: "copy-of-a", text: "Copy" };
  const state = validateCanvasState({
    nodes: [built.diagram, ...built.nodes, drawn, copy],
    connectors: [...built.connectors, { id: "a-drawn", from: { nodeId: shapeA.id, anchor: "auto" }, to: { nodeId: "drawn-1", anchor: "auto" } }],
  });
  const code = diagramToMermaid(state, built.diagram.id);
  assert.equal(parseMermaid(code).nodes.length, 4);
  const next = replaceDiagramContent(state, built.diagram.id, parseMermaid(code), code);
  const children = next.nodes.filter((n) => n.parentId === built.diagram.id);
  assert.deepEqual(children.map((n) => n.id).sort(), [shapeA.id, built.nodes[1].id, "copy-of-a", "drawn-1"].sort());
  assert.equal(next.nodes.find((n) => n.id === "drawn-1").text, "Mine");
  assert.equal(next.connectors.length, 2);
  const saved = validateCanvasState(next);
  assert.equal(diagramToMermaid(saved, built.diagram.id), code);
});
