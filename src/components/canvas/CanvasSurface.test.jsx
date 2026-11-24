import test from "node:test";
import assert from "node:assert/strict";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { createRoot } from "react-dom/client";
import { useCanvasStore } from "../../lib/canvas-store.js";
import { emptyCanvasState } from "../../lib/canvas/serialization.js";
import { CanvasSurface } from "./CanvasSurface.jsx";

const sticky = { id: "s1", type: "sticky", x: 100, y: 100, w: 120, h: 120, text: "", color: "yellow", parentId: null, groupId: null };

async function withSurface(run) {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost", pretendToBeVisual: true });
  const names = ["window", "document", "HTMLElement", "Element", "React", "IS_REACT_ACT_ENVIRONMENT", "ResizeObserver", "requestAnimationFrame", "cancelAnimationFrame", "getComputedStyle"];
  const prior = Object.fromEntries(names.map((n) => [n, globalThis[n]]));
  Object.assign(globalThis, {
    window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, React,
    IS_REACT_ACT_ENVIRONMENT: true, getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: (cb) => setTimeout(cb, 0), cancelAnimationFrame: (id) => clearTimeout(id),
    ResizeObserver: class { constructor(cb) { this.cb = cb; } observe(el) { this.cb([{ target: el, contentRect: { width: 1000, height: 800 } }]); } unobserve() {} disconnect() {} },
  });
  useCanvasStore.setState({
    boardId: "board-1", loaded: true, tool: "select", selection: [], selectedConnectorIds: [],
    history: { past: [], present: { ...emptyCanvasState(), nodes: [sticky] }, future: [] },
  });
  const transient = [];
  const root = createRoot(document.querySelector("#root"));
  const pointer = (type, init = {}) => Object.assign(new dom.window.Event(type, { bubbles: true, cancelable: true }), { pointerId: 1, pointerType: "mouse", button: 0, buttons: 1, isPrimary: true, clientX: 0, clientY: 0, ...init });
  try {
    await act(async () => root.render(React.createElement(CanvasSurface, { boardId: "board-1", onTransientChange: (v) => transient.push(v) })));
    const surface = document.querySelector("[data-board-surface]");
    const node = document.querySelector('[data-node-id="s1"]');
    assert.ok(node, "the sticky renders");
    const fire = (el, type, init) => act(async () => { el.dispatchEvent(pointer(type, init)); });
    await run({ fire, surface, node, transient, state: () => useCanvasStore.getState() });
  } finally {
    await act(async () => root.unmount());
    useCanvasStore.getState().reset();
    Object.assign(globalThis, prior);
    dom.window.close();
  }
}

test("a single node drag commits exactly one history entry and moves the node", async () => {
  await withSurface(async ({ fire, surface, node, state }) => {
    await fire(node, "pointerdown", { clientX: 150, clientY: 150 });
    for (const x of [160, 190, 250]) await fire(surface, "pointermove", { clientX: x, clientY: 150 });
    await fire(surface, "pointerup", { clientX: 250, clientY: 150, buttons: 0 });
    assert.equal(state().history.past.length, 0, "the gesture is open until it idles");
    await new Promise((r) => setTimeout(r, 900));
    assert.equal(state().history.past.length, 1);
    assert.ok(state().history.present.nodes[0].x > sticky.x);
  });
});

test("pointercancel drops the drag: nothing is committed and the next release does not commit it", async () => {
  await withSurface(async ({ fire, surface, node, transient, state }) => {
    await fire(node, "pointerdown", { clientX: 150, clientY: 150 });
    await fire(surface, "pointermove", { clientX: 250, clientY: 150 });
    await fire(surface, "pointercancel", { clientX: 250, clientY: 150, buttons: 0 });
    assert.equal(transient[transient.length - 1], false);
    await fire(surface, "pointerup", { clientX: 250, clientY: 150, buttons: 0 });
    assert.equal(state().history.past.length, 0);
    assert.equal(state().history.present.nodes[0].x, sticky.x);
  });
});
