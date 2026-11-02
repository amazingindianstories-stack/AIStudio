import test from "node:test";
import assert from "node:assert/strict";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { AccessibilityPanel } from "./AccessibilityPanel.jsx";
import { useCanvasStore } from "../../lib/canvas-store.js";
import { emptyCanvasState } from "../../lib/canvas/serialization.js";

function withDom(t) {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost", pretendToBeVisual: true });
  const names = ["window", "document", "HTMLElement", "React", "IS_REACT_ACT_ENVIRONMENT", "requestAnimationFrame", "cancelAnimationFrame", "getComputedStyle", "ResizeObserver"];
  const prior = Object.fromEntries(names.map((name) => [name, globalThis[name]]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, React,
    IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: (fn) => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout,
    getComputedStyle: dom.window.getComputedStyle, ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } });
  dom.window.HTMLElement.prototype.scrollIntoView = function () {};
  t.after(() => Object.assign(globalThis, prior));
}

const image = (id, x, extra = {}) => ({ id, type: "image", src: `/api/media/${id}.png`, x, y: 0, w: 100, h: 100, parentId: null, groupId: null, ...extra });

test("a locked object's missing description cannot be written here, and the panel says why", async (t) => {
  withDom(t);
  const original = useCanvasStore.getState();
  useCanvasStore.setState({ boardId: "board-1", boardRole: "owner", accessLost: false, selection: [],
    history: { past: [], present: { ...emptyCanvasState(), nodes: [image("open", 0), image("held", 200, { locked: true })] }, future: [] } });
  // react-dom/client decides at import whether native `input` events exist, so it loads after the DOM.
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.querySelector("#root"));
  await act(async () => root.render(React.createElement(AccessibilityPanel, { canEdit: true, onClose() {} })));
  t.after(async () => {
    await act(async () => root.unmount());
    useCanvasStore.getState().reset();
    useCanvasStore.setState(original, true);
  });
  const items = [...document.querySelectorAll("li")];
  assert.equal(items.length, 2);
  const inputs = items.map((li) => li.querySelector("input[aria-label='Image description']"));
  const copy = items.map((li) => li.textContent.includes("Locked - unlock to edit"));
  // Issues list in reading order: the unlocked image first.
  assert.ok(inputs[0]);
  assert.equal(copy[0], false);
  assert.equal(inputs[1], null);
  assert.equal(copy[1], true);
});
