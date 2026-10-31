import test from "node:test";
import assert from "node:assert/strict";
import { addSlide, frameContents, moveSlide } from "./slides.js";
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

test("every wireframe component is a persistable native node", () => {
  for (const item of WIREFRAMES) {
    const node = wireframeNode(item, { x: 500, y: 500 });
    assert.equal(validateCanvasState({ nodes: [node] }).nodes[0]?.type, node.type, item.name);
  }
});
