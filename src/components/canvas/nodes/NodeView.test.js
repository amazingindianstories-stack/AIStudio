import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { createRoot } from "react-dom/client";
import { NodeView } from "./NodeView.jsx";

const h = React.createElement;
const noop = () => {};

/** Mounts a NodeView under a parent that re-renders on demand; counts how often the node itself rendered. */
async function mount(t, node, extraProps = {}) {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost", pretendToBeVisual: true });
  const names = ["window", "document", "HTMLElement", "Node", "React", "IS_REACT_ACT_ENVIRONMENT"];
  const prior = Object.fromEntries(names.map((name) => [name, globalThis[name]]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, React, IS_REACT_ACT_ENVIRONMENT: true });
  const root = createRoot(dom.window.document.getElementById("root"));
  t.after(async () => {
    await act(async () => root.unmount());
    for (const name of names) Object.defineProperty(globalThis, name, { value: prior[name], configurable: true, writable: true });
    dom.window.close();
  });
  // NodeView reads `node.x` while rendering and never while deciding whether to; count those reads.
  let renders = 0;
  const watched = (n) => Object.defineProperty({ ...n }, "x", { enumerable: true, get() { renders += 1; return n.x; } });
  const base = {
    node: watched(node), tool: "select", showRing: false, showHandles: false, readOnly: false, editingTextId: null, dragging: false,
    onPointerDownBody: noop, onDoubleClickBody: noop, onCommitText: noop, onCancelEdit: noop, onPointerDownHandle: noop,
    nodesById: { [node.id]: node }, viewport: { x: 0, y: 0, zoom: 1 }, viewportSize: { w: 800, h: 600 },
  };
  const render = (props) =>
    act(async () => {
      root.render(h(NodeView, { ...base, ...extraProps, ...props }));
    });
  await render({});
  return { render, renders: () => renders };
}

test("an object does not render again when the surface re-renders with the same props or only a new viewport", async (t) => {
  const node = { id: "r", type: "rect", x: 0, y: 0, w: 100, h: 50, parentId: null, groupId: null };
  const view = await mount(t, node);
  const first = view.renders();
  assert.ok(first >= 1);
  await view.render({});
  await view.render({ viewport: { x: 40, y: 10, zoom: 2 }, viewportSize: { w: 800, h: 600 }, nodesById: { r: node, other: {} } });
  assert.equal(view.renders(), first);
});

test("an object renders again when something it draws changes", async (t) => {
  const node = { id: "r", type: "rect", x: 0, y: 0, w: 100, h: 50, parentId: null, groupId: null };
  const view = await mount(t, node);
  const first = view.renders();
  await view.render({ selected: true });
  const afterSelect = view.renders();
  assert.ok(afterSelect > first);
  await view.render({ selected: true });
  assert.equal(view.renders(), afterSelect);
});
