import test from "node:test";
import assert from "node:assert/strict";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { createRoot } from "react-dom/client";
import { useCanvasStore } from "../canvas-store.js";
import { BOARD_COPY_ATTRIBUTE } from "./board-clipboard.js";
import { useBoardClipboard } from "./use-board-clipboard.js";

async function withBoard(run) {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost", pretendToBeVisual: true });
  const names = ["window", "document", "HTMLElement", "React", "IS_REACT_ACT_ENVIRONMENT"];
  const prior = Object.fromEntries(names.map((n) => [n, globalThis[n]]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, React, IS_REACT_ACT_ENVIRONMENT: true });
  const root = createRoot(document.querySelector("#root"));
  const priorPaste = useCanvasStore.getState().paste;
  let pastes = 0;
  useCanvasStore.setState({ paste: () => { pastes += 1; } });
  const imports = [];
  function Harness() {
    useBoardClipboard({ importImageFiles: (files) => imports.push(files), importLink: null, touchViewOnly: false, viewCenter: () => ({ x: 0, y: 0 }), notify() {} });
    return null;
  }
  const paste = (html, target = document) => {
    const event = new dom.window.Event("paste", { bubbles: true, cancelable: true });
    event.clipboardData = { files: [], getData: (type) => (type === "text/html" ? html : "") };
    target.dispatchEvent(event);
    return event;
  };
  try {
    await act(async () => root.render(React.createElement(Harness)));
    await run({ paste, pastes: () => pastes, imports, document });
  } finally {
    await act(async () => root.unmount());
    useCanvasStore.setState({ paste: priorPaste });
    Object.assign(globalThis, prior);
    dom.window.close();
  }
}

test("paste of a board copy calls state.paste() and cancels the browser default", async () => {
  await withBoard(async ({ paste, pastes }) => {
    const event = paste(`<div ${BOARD_COPY_ATTRIBUTE}="1"></div>`);
    assert.equal(pastes(), 1);
    assert.equal(event.defaultPrevented, true);
  });
});

test("paste with a modal open is ignored", async () => {
  await withBoard(async ({ paste, pastes, document }) => {
    const modal = document.createElement("div");
    modal.setAttribute("aria-modal", "true");
    document.body.appendChild(modal);
    const event = paste(`<div ${BOARD_COPY_ATTRIBUTE}="1"></div>`);
    assert.equal(pastes(), 0);
    assert.equal(event.defaultPrevented, false);
  });
});

test("paste into a text field is left to the field", async () => {
  await withBoard(async ({ paste, pastes, document }) => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    const event = paste(`<div ${BOARD_COPY_ATTRIBUTE}="1"></div>`, input);
    assert.equal(pastes(), 0);
    assert.equal(event.defaultPrevented, false);
  });
});

test("the paste listener is removed on unmount", async () => {
  const dom = new JSDOM("<div id=\"root\"></div>", { url: "http://localhost" });
  const names = ["window", "document", "HTMLElement", "React", "IS_REACT_ACT_ENVIRONMENT"];
  const prior = Object.fromEntries(names.map((n) => [n, globalThis[n]]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, React, IS_REACT_ACT_ENVIRONMENT: true });
  const added = [];
  const removed = [];
  const add = document.addEventListener.bind(document);
  const remove = document.removeEventListener.bind(document);
  document.addEventListener = (type, fn, o) => { added.push([type, fn]); add(type, fn, o); };
  document.removeEventListener = (type, fn, o) => { removed.push([type, fn]); remove(type, fn, o); };
  const root = createRoot(document.querySelector("#root"));
  const Harness = () => { useBoardClipboard({ importImageFiles() {}, importLink: null, touchViewOnly: false, viewCenter: () => ({ x: 0, y: 0 }), notify() {} }); return null; };
  try {
    await act(async () => root.render(React.createElement(Harness)));
    await act(async () => root.unmount());
    for (const [type, fn] of added.filter(([t]) => ["paste", "copy", "cut"].includes(t))) {
      assert.ok(removed.some(([t, f]) => t === type && f === fn), `${type} listener removed`);
    }
    assert.ok(added.some(([t]) => t === "paste"));
  } finally {
    Object.assign(globalThis, prior);
    dom.window.close();
  }
});
