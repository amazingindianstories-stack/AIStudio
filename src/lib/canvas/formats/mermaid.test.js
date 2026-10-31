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
