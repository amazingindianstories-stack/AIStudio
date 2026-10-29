import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { useCanvasStore } from "./canvas-store.js";
import { emptyCanvasState, validateCanvasState } from "./canvas/serialization.js";
import { BASIC_SHAPES } from "./canvas/shapes.js";
import { buildDefaultNode } from "../components/canvas/CanvasSurface.jsx";
import { ShapeNode } from "../components/canvas/nodes/ShapeNode.jsx";
import { TextNode } from "../components/canvas/nodes/TextNode.jsx";
import { StickyNode } from "../components/canvas/nodes/StickyNode.jsx";

globalThis.React = React;

const sticky = { id: "n1", type: "sticky", x: 0, y: 0, w: 100, h: 100, text: "hi", fill: "#fde68a", fontSize: 16, color: "#111", opacity: 1, parentId: null, groupId: null };
const frame = { id: "f1", type: "frame", x: 0, y: 0, w: 300, h: 300, name: "Frame", fill: "transparent", stroke: "#000", parentId: null, groupId: null };
const star = { id: "s1", type: "shape", shape: "star", x: 0, y: 0, w: 150, h: 143, fill: "#fff", stroke: "#000", strokeWidth: 2, parentId: null, groupId: null };

const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

async function editableBoard(t, nodes) {
  t.mock.method(globalThis, "fetch", async (url, init = {}) =>
    (init.method || "GET") === "PUT"
      ? json({ ok: true, updatedAt: Date.now() })
      : json({ id: "board-1", name: "Board", data: { ...emptyCanvasState(), nodes }, updatedAt: 1, role: "edit" }));
  const store = useCanvasStore;
  store.getState().reset();
  await store.getState().loadBoard("board-1");
  t.after(() => store.getState().reset());
  return store;
}

const nodeById = (store, id) => store.getState().history.present.nodes.find((n) => n.id === id);

test("commitNodeText stores text with its marks, as one undo step, on the node it names", async (t) => {
  const store = await editableBoard(t, [sticky, star]);
  store.getState().setSelection(["s1"]);
  store.getState().commitNodeText("n1", "hello world", [[0, 5, "b"], [6, 11, "a", "https://example.com"]]);
  assert.deepEqual(nodeById(store, "n1").marks, [[0, 5, "b"], [6, 11, "a", "https://example.com"]]);
  assert.equal(nodeById(store, "n1").text, "hello world");
  assert.equal(nodeById(store, "s1").text, undefined, "the selection is not what gets the text");
  assert.equal(store.getState().history.past.length, 1);
  assert.equal(store.getState().saveStatus, "dirty");

  // Unchanged text and marks add no history.
  store.getState().commitNodeText("n1", "hello world", [[0, 5, "b"], [6, 11, "a", "https://example.com"]]);
  assert.equal(store.getState().history.past.length, 1);

  // Removing all formatting removes the key, so the board stays plain.
  store.getState().commitNodeText("n1", "hello world", []);
  assert.equal("marks" in nodeById(store, "n1"), false);

  store.getState().commitNodeText("s1", "star text", [[0, 4, "i"]]);
  assert.deepEqual(validateCanvasState(store.getState().history.present).nodes.find((n) => n.id === "s1"), {
    ...star, text: "star text", marks: [[0, 4, "i"]],
  });
  store.getState().undo();
  assert.equal(nodeById(store, "s1").text, undefined);
});

test("a committed text box grows to its content height but never shrinks", async (t) => {
  const text = { id: "t1", type: "text", x: 0, y: 0, w: 200, h: 32, text: "", fontSize: 16, align: "left", color: "#fff", parentId: null, groupId: null };
  const store = await editableBoard(t, [text, sticky]);
  store.getState().commitNodeText("t1", "two lines", [], 48);
  assert.equal(nodeById(store, "t1").h, 48);
  store.getState().commitNodeText("t1", "one", [], 24);
  assert.equal(nodeById(store, "t1").h, 48);
  store.getState().commitNodeText("n1", "sticky", [], 400);
  assert.equal(nodeById(store, "n1").h, 100, "stickies keep their size");
});

test("commitNodeText renames frames", async (t) => {
  const store = await editableBoard(t, [frame]);
  store.getState().commitNodeText("f1", "Storyboard", null);
  assert.equal(nodeById(store, "f1").name, "Storyboard");
  assert.equal("text" in nodeById(store, "f1"), false);
});

test("style patches reach path shapes, including text color and size", async (t) => {
  const store = await editableBoard(t, [star]);
  store.getState().setSelection(["s1"]);
  store.getState().updateSelectedStyle({ fill: "#7fae86", stroke: "#ffffff", strokeWidth: 4, color: "#1c1a12", fontSize: 24, cornerRadius: 9 });
  const node = nodeById(store, "s1");
  assert.deepEqual([node.fill, node.stroke, node.strokeWidth, node.color, node.fontSize, node.cornerRadius], ["#7fae86", "#ffffff", 4, "#1c1a12", 24, undefined]);
  assert.equal(node.shape, "star");
});

test("every basic shape tool builds a node the format keeps", () => {
  for (const { tool } of BASIC_SHAPES) {
    const node = buildDefaultNode(tool, { x: 0, y: 0 });
    const [kept] = validateCanvasState({ nodes: [node] }).nodes;
    assert.ok(kept, tool);
    if (tool.startsWith("shape:")) assert.equal(kept.shape, tool.slice(6));
  }
  assert.equal(buildDefaultNode("rect-rounded", { x: 0, y: 0 }).cornerRadius, 16);
  assert.equal(buildDefaultNode("rect-rounded", { x: 0, y: 0 }).type, "rect");
});

test("ShapeNode draws each path shape's outline and its formatted text", () => {
  for (const { tool } of BASIC_SHAPES) {
    const node = buildDefaultNode(tool, { x: 0, y: 0 });
    const html = renderToStaticMarkup(React.createElement(ShapeNode, { node, editing: false }));
    assert.match(html, /<svg/, tool);
    if (node.type === "shape") {
      assert.match(html, new RegExp(`data-shape-outline="${node.shape}"`), tool);
      assert.match(html, /pointer-events="all"/, tool);
      assert.match(html, / d="M[\d.]+ [\d.]+ L/, tool);
    }
  }
  const unknown = renderToStaticMarkup(React.createElement(ShapeNode, { node: { ...star, shape: "flowchart-process" } }));
  assert.match(unknown, /d="M1 1 L149 1 L149 142 L1 142 Z"/, "unknown kinds draw a rectangle");
  const withText = renderToStaticMarkup(React.createElement(ShapeNode, { node: { ...star, text: "Go now", marks: [[0, 2, "b"]] } }));
  assert.match(withText, /<b class="font-bold">Go<\/b> now/);
  assert.doesNotMatch(renderToStaticMarkup(React.createElement(ShapeNode, { node: star })), /font-bold|Edit text/);
});

test("text and sticky nodes render marks and keep plain text unchanged", () => {
  const text = { id: "t", type: "text", x: 0, y: 0, w: 100, h: 20, text: "plain <i>", fontSize: 16, align: "left", color: "#fff" };
  assert.match(renderToStaticMarkup(React.createElement(TextNode, { node: text })), />plain &lt;i&gt;<\/div>$/);
  const html = renderToStaticMarkup(React.createElement(StickyNode, { node: { ...sticky, text: "mark me", marks: [[0, 4, "h", "#86efac"], [5, 7, "s"]] } }));
  assert.match(html, /<span class="rounded-\[2px\]" style="background-color:#86efac8c">mark<\/span> <s>me<\/s>/);
});

test("an empty edit on a shape without text is a no-op", async (t) => {
  const store = await editableBoard(t, [star]);
  store.getState().commitNodeText("s1", "", []);
  assert.equal("text" in nodeById(store, "s1"), false);
  assert.equal(store.getState().history.past.length, 0);
  assert.notEqual(store.getState().saveStatus, "dirty");
});
