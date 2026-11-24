import assert from "node:assert/strict";
import test from "node:test";
import { startPresentation } from "./useBoardShortcuts.js";
import { stopPresentation } from "./BoardPresentation.jsx";
import { useBoardUi } from "../../lib/canvas/board-ui.js";
import { useCanvasStore } from "../../lib/canvas-store.js";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { createRoot } from "react-dom/client";
import { dispatchShortcut } from "../../lib/canvas/shortcuts.js";
import { useSpaceHeld } from "./use-space-pan.js";

test("starting the presentation again from a board break still returns to the view from before it", () => {
  const frame = { id: "f", type: "frame", name: "Intro", x: 0, y: 0, w: 400, h: 300, parentId: null, groupId: null };
  const before = { x: 10, y: 20, zoom: 1 };
  useCanvasStore.setState({ history: { past: [], present: { version: 1, viewport: before, nodes: [frame], connectors: [] }, future: [] } });
  try {
    startPresentation();
    const ui = useBoardUi.getState();
    ui.setPresenting({ ...ui.presenting, index: 0, onBoard: true });
    useCanvasStore.getState().showViewport({ x: 500, y: 500, zoom: 2 });
    startPresentation();
    assert.deepEqual(useBoardUi.getState().presenting.returnViewport, before);
    stopPresentation();
    assert.equal(useBoardUi.getState().presenting, null);
    assert.deepEqual(useCanvasStore.getState().history.present.viewport, before);
  } finally {
    useBoardUi.getState().setPresenting(null);
    useCanvasStore.getState().reset();
  }
});

/** A bare DOM with a board surface and a toolbar button beside it, restored after the test. */
function installDom(t) {
  const dom = new JSDOM("<div id='root'></div><div data-board-surface tabindex='0' id='surface'></div><button id='tool'>Tool</button>", { url: "http://localhost", pretendToBeVisual: true });
  const names = ["window", "document", "HTMLElement", "Node", "React", "IS_REACT_ACT_ENVIRONMENT"];
  const prior = Object.fromEntries(names.map((name) => [name, globalThis[name]]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, React, IS_REACT_ACT_ENVIRONMENT: true });
  const cleanups = [];
  t.after(async () => {
    for (const cleanup of cleanups) await cleanup();
    for (const name of names) Object.defineProperty(globalThis, name, { value: prior[name], configurable: true, writable: true });
    dom.window.close();
  });
  return { dom, cleanups };
}

const keydown = (target, init) => {
  const event = new window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
};

test("Escape with focus on a control outside the board leaves the selection alone, and acts on the board", (t) => {
  installDom(t);
  const key = (target) => { const event = new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }); Object.defineProperty(event, "target", { value: target }); return event; };
  let cleared = 0;
  const ctx = { store: { tool: "select", selection: ["a"], history: { present: { nodes: [], connectors: [] } }, clearSelection: () => { cleared += 1; } }, ui: {}, canEdit: true };
  assert.equal(dispatchShortcut(key(document.querySelector("#tool")), ctx), false);
  assert.equal(cleared, 0);
  assert.equal(dispatchShortcut(key(document.querySelector("#surface")), ctx), true);
  assert.equal(cleared, 1);
});

async function mountPan(t) {
  const { cleanups } = installDom(t);
  function Probe() {
    return React.createElement("i", { id: "pan", "data-held": String(useSpaceHeld()) });
  }
  const root = createRoot(document.querySelector("#root"));
  cleanups.push(() => act(async () => root.unmount()));
  await act(async () => root.render(React.createElement(Probe)));
  return () => document.querySelector("#pan").getAttribute("data-held") === "true";
}

test("Space arms panning on the board, but not when it activates a focused button", async (t) => {
  const held = await mountPan(t);
  await act(async () => { keydown(document.querySelector("#tool"), { code: "Space", key: " " }); });
  assert.equal(held(), false);
  await act(async () => { keydown(document.querySelector("#surface"), { code: "Space", key: " " }); });
  assert.equal(held(), true);
});

test("Space with focus on a link or other control outside the board does not arm panning", async (t) => {
  const held = await mountPan(t);
  document.body.insertAdjacentHTML("beforeend", "<a id='link' href='#'>Link</a><svg><g id='record' role='button' tabindex='0'></g></svg>");
  await act(async () => { keydown(document.querySelector("#link"), { code: "Space", key: " " }); });
  assert.equal(held(), false);
  await act(async () => { keydown(document.querySelector("#record"), { code: "Space", key: " " }); });
  assert.equal(held(), false);
  await act(async () => { keydown(document.body, { code: "Space", key: " " }); });
  assert.equal(held(), true);
});

test("Space held while the window loses focus does not leave the board in pan mode", async (t) => {
  const held = await mountPan(t);
  await act(async () => { keydown(document.querySelector("#surface"), { code: "Space", key: " " }); });
  assert.equal(held(), true);
  await act(async () => { window.dispatchEvent(new window.Event("blur")); });
  assert.equal(held(), false);
});

test("Space inside an open dialog never arms panning", async (t) => {
  const held = await mountPan(t);
  document.body.insertAdjacentHTML("beforeend", "<div aria-modal='true' role='dialog'><div id='in' tabindex='0'></div></div>");
  await act(async () => { keydown(document.querySelector("#surface"), { code: "Space", key: " " }); });
  assert.equal(held(), false);
});
