import test from "node:test";
import assert from "node:assert/strict";
import { addSlide, frameContents, moveIntoFrame, moveSlide } from "./slides.js";
import { WIREFRAMES, wireframeNode } from "./wireframes.js";
import { validateCanvasState } from "../serialization.js";

test("deck ordering, frame references and lanes survive serialization", () => {
  const frame = wireframeNode(WIREFRAMES[0], { x: 500, y: 500 });
  const slides = addSlide([], frame);
  assert.equal(slides[0].frameId, frame.id);
  assert.equal(addSlide(slides, { type: "rect" }), slides);
  assert.deepEqual(moveSlide([...slides, { id: "two" }], "two", -1).map((s) => s.id), ["two", slides[0].id]);
  const state = validateCanvasState({ nodes: [frame, { id: "deck", type: "format", format: "deck", x: 0, y: 0, w: 400, h: 300, slides, lanes: [{ id: "main", name: "Main" }] }] });
  assert.deepEqual(state.nodes[1].slides, slides);
});

test("previews use all nested saved content and internal connectors, including offscreen nodes", () => {
  const graph = { nodes: [{ id: "f" }, { id: "nested", parentId: "f" }, { id: "offscreen", parentId: "nested", x: 100000 }, { id: "outside" }], connectors: [{ id: "inside", from: { nodeId: "nested" }, to: { nodeId: "offscreen" } }, { id: "external", from: { nodeId: "outside" }, to: { nodeId: "nested" } }] };
  assert.deepEqual(frameContents(graph, "f").nodes.map((n) => n.id), ["f", "nested", "offscreen"]);
  assert.deepEqual(frameContents(graph, "f").connectors.map((c) => c.id), ["inside"]);
});

test("dropping a container into a slide moves its contents with it", () => {
  const frame = { id: "f", type: "frame", x: 1000, y: 1000, w: 400, h: 300 };
  const graph = { nodes: [frame, { id: "d", type: "diagram", x: 0, y: 0, w: 200, h: 100 }, { id: "a", type: "rect", x: 40, y: 60, w: 20, h: 20, parentId: "d", mermaidKey: "A" }, { id: "other", type: "rect", x: 5, y: 5, w: 1, h: 1 }], connectors: [] };
  const next = moveIntoFrame(graph, "d", frame);
  const byId = Object.fromEntries(next.nodes.map((n) => [n.id, n]));
  assert.deepEqual([byId.d.x, byId.d.y, byId.d.parentId], [1040, 1060, "f"]);
  assert.deepEqual([byId.a.x, byId.a.y, byId.a.parentId, byId.a.mermaidKey], [1080, 1120, "d", "A"]);
  const dropped = moveIntoFrame(graph, "a", frame).nodes.find((n) => n.id === "a");
  assert.deepEqual([dropped.parentId, dropped.mermaidKey], ["f", undefined]);
  assert.equal(byId.other, graph.nodes[3]);
  assert.equal(moveIntoFrame(graph, "f", frame), graph);
});

test("every wireframe component is a persistable native node with readable text", () => {
  for (const item of WIREFRAMES) {
    const node = wireframeNode(item, { x: 500, y: 500 });
    const saved = validateCanvasState({ nodes: [node] }).nodes[0];
    assert.equal(saved?.type, node.type, item.name);
    if (node.type !== "frame") {
      assert.equal(saved.color, "#0f172a", item.name);
      assert.equal(saved.align, "center", item.name);
      assert.equal(saved.text, item.text, item.name);
    }
  }
});
