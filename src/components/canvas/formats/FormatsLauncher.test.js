import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { createRoot } from "react-dom/client";
import { CanvasToolbar } from "../CanvasToolbar.jsx";
import { FormatsPanel } from "./FormatsPanel.jsx";
import { useCanvasStore } from "../../../lib/canvas-store.js";
import { useBoardPrefs } from "../../../lib/canvas/board-prefs.js";
import { emptyCanvasState } from "../../../lib/canvas/serialization.js";

const LAUNCHER = "button[aria-label='Docs, slides and prototypes']";

async function board({ boardRole, viewOnly = false, hidden = [] }, run) {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost", pretendToBeVisual: true });
  const names = ["window", "document", "HTMLElement", "Node", "React", "IS_REACT_ACT_ENVIRONMENT", "localStorage"];
  const prior = Object.fromEntries(names.map((name) => [name, globalThis[name]]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, React,
    IS_REACT_ACT_ENVIRONMENT: true, localStorage: dom.window.localStorage });
  dom.window.localStorage.setItem("veevee-board-prefs-v1", JSON.stringify({ toolbarHidden: hidden }));
  useBoardPrefs.setState({ hydrated: false });
  const present = { ...emptyCanvasState(), nodes: [{ id: "f1", type: "frame", name: "Home", x: 0, y: 0, w: 100, h: 100 }] };
  useCanvasStore.setState({ boardId: "board-1", loaded: true, boardRole, serverVersion: 1, history: { past: [], present, future: [] } });
  const root = createRoot(document.querySelector("#root"));
  try {
    await act(async () => root.render(React.createElement(React.Fragment, null,
      React.createElement(FormatsPanel, { boardId: "board-1", touchViewOnly: viewOnly }),
      React.createElement(CanvasToolbar, { readOnly: boardRole !== "edit", viewOnly, toolLocked: false, onToggleLock() {}, onAddImageClick() {} }))));
    await run();
  } finally {
    await act(async () => root.unmount());
    useCanvasStore.getState().reset();
    useBoardPrefs.setState({ toolbarHidden: [], toolbarOrder: [], hydrated: false });
    Object.assign(globalThis, prior);
    dom.window.close();
  }
}

const drawer = () => document.querySelector("[role=region][aria-label='Board formats']");
const buttons = () => [...drawer().querySelectorAll("button")].map((button) => button.textContent.trim());

async function openDrawer() {
  const launcher = document.querySelector(LAUNCHER);
  assert.ok(launcher, "the toolbar has a Formats launcher");
  assert.equal(drawer(), null);
  await act(async () => launcher.click());
  assert.ok(drawer(), "the launcher opens the drawer");
  assert.equal(document.querySelector(LAUNCHER).getAttribute("aria-pressed"), "true");
}

test("editors open the formats drawer from the toolbar and can create formats", async () => {
  await board({ boardRole: "edit" }, async () => {
    await openDrawer();
    assert.ok(buttons().includes("New doc"));
    assert.ok(buttons().includes("Preview Home"));
    await act(async () => document.querySelector(LAUNCHER).click());
    assert.equal(drawer(), null, "a second click closes it");
    assert.equal(document.querySelector(LAUNCHER).getAttribute("aria-pressed"), "false");
  });
});

test("an editor who unpins the formats tool loses the toolbar launcher", async () => {
  await board({ boardRole: "edit", hidden: ["formats"] }, async () => {
    assert.equal(document.querySelector(LAUNCHER), null);
  });
});

test("viewers and commenters still open the drawer to read and preview, without create or wireframe tools", async () => {
  for (const boardRole of ["view", "comment"]) {
    await board({ boardRole, hidden: ["formats"] }, async () => {
      await openDrawer();
      assert.ok(buttons().includes("Preview Home"));
      assert.equal(buttons().includes("New doc"), false);
      assert.equal(/Wireframing library/.test(drawer().textContent), false);
    });
  }
});

test("touch view mode keeps a formats launcher while hiding every other tool", async () => {
  await board({ boardRole: "view", viewOnly: true }, async () => {
    assert.equal(document.querySelector("button[aria-label='Select']"), null);
    await openDrawer();
    assert.ok(buttons().includes("Preview Home"));
    assert.equal(buttons().includes("New doc"), false);
  });
});
