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

test("only plain objects drop into a slide; diagrams, swimlanes, frames and formats stay where they are", () => {
  const frame = { id: "f", type: "frame", x: 1000, y: 1000, w: 400, h: 300 };
  const graph = { nodes: [frame,
    { id: "d", type: "diagram", x: 0, y: 0, w: 200, h: 100 },
    { id: "a", type: "rect", x: 40, y: 60, w: 20, h: 20, parentId: "d", mermaidKey: "A" },
    { id: "lane", type: "swimlane", x: 0, y: 500, w: 200, h: 100 },
    { id: "other", type: "frame", x: 0, y: 800, w: 100, h: 100 },
    { id: "deck", type: "format", format: "deck", x: 0, y: 900, w: 100, h: 100 },
    { id: "s", type: "sticky", x: 5, y: 5, w: 10, h: 10 }], connectors: [] };
  for (const id of ["d", "lane", "other", "deck", "f"]) assert.equal(moveIntoFrame(graph, id, frame), graph, id);
  const next = moveIntoFrame(graph, "a", frame);
  const dropped = next.nodes.find((n) => n.id === "a");
  assert.deepEqual([dropped.x, dropped.y, dropped.parentId, dropped.mermaidKey], [1040, 1060, "f", undefined]);
  assert.deepEqual(next.nodes.filter((n) => n.id !== "a"), graph.nodes.filter((n) => n.id !== "a"));
  const sticky = moveIntoFrame(graph, "s", frame).nodes.find((n) => n.id === "s");
  assert.deepEqual([sticky.x, sticky.y, sticky.parentId], [1040, 1060, "f"]);
});

test("a diagram wrapping a slide's frame is never dropped into that frame", () => {
  const graph = { nodes: [
    { id: "d", type: "diagram", x: 0, y: 0, w: 600, h: 500 },
    { id: "f", type: "frame", x: 40, y: 60, w: 400, h: 300, parentId: "d" }], connectors: [] };
  assert.equal(moveIntoFrame(graph, "d", graph.nodes[1]), graph);
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
