import test from "node:test";
import assert from "node:assert/strict";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { createRoot } from "react-dom/client";
import { useCanvasStore } from "../../../lib/canvas-store.js";
import { emptyCanvasState } from "../../../lib/canvas/serialization.js";
import { DrawioEditor } from "./DrawioEditor.jsx";

const ORIGIN = "https://embed.diagrams.net";

async function withEditor(run) {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost", pretendToBeVisual: true });
  const names = ["window", "document", "HTMLElement", "React", "IS_REACT_ACT_ENVIRONMENT"];
  const prior = Object.fromEntries(names.map((n) => [n, globalThis[n]]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, React, IS_REACT_ACT_ENVIRONMENT: true });
  const node = { id: "d1", type: "diagram", name: "Flow", x: 0, y: 0, w: 100, h: 100, xml: "<old/>", parentId: null, groupId: null };
  useCanvasStore.setState({ boardId: "board-1", history: { past: [], present: { ...emptyCanvasState(), nodes: [node] }, future: [] } });
  const root = createRoot(document.querySelector("#root"));
  try {
    await act(async () => root.render(React.createElement(DrawioEditor, { node, readOnly: false })));
    await act(async () => { document.querySelector("button").click(); });
    const iframe = document.querySelector("iframe");
    const sent = [];
    Object.defineProperty(iframe, "contentWindow", { value: { postMessage: (m, o) => sent.push([JSON.parse(m), o]) }, configurable: true });
    const post = (data, { origin = ORIGIN, source = iframe.contentWindow } = {}) =>
      act(async () => { window.dispatchEvent(Object.assign(new dom.window.Event("message"), { data: JSON.stringify(data), origin, source })); });
    await run({ post, sent, xml: () => useCanvasStore.getState().history.present.nodes[0].xml });
  } finally {
    await act(async () => root.unmount());
    useCanvasStore.getState().reset();
    Object.assign(globalThis, prior);
    dom.window.close();
  }
}

test("a message from the wrong origin is ignored", async () => {
  await withEditor(async ({ post, sent, xml }) => {
    await post({ event: "save", xml: "<evil/>" }, { origin: "https://evil.example" });
    await post({ event: "init" }, { origin: "https://evil.example" });
    assert.equal(xml(), "<old/>");
    assert.equal(sent.length, 0);
  });
});

test("a message from a different window is ignored", async () => {
  await withEditor(async ({ post, sent, xml }) => {
    await post({ event: "save", xml: "<evil/>" }, { source: {} });
    assert.equal(xml(), "<old/>");
    assert.equal(sent.length, 0);
  });
});

test("a valid save event patches the diagram XML and asks for a preview export", async () => {
  await withEditor(async ({ post, sent, xml }) => {
    await post({ event: "save", xml: "<new/>" });
    assert.equal(xml(), "<new/>");
    assert.deepEqual(sent.map(([m]) => m.action), ["export"]);
    assert.equal(sent[0][1], ORIGIN);
  });
});

test("init loads the current diagram into the editor", async () => {
  await withEditor(async ({ post, sent }) => {
    await post({ event: "init" });
    assert.equal(sent[0][0].action, "load");
    assert.equal(sent[0][0].xml, "<old/>");
  });
});
