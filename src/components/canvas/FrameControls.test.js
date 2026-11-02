import test from "node:test";
import assert from "node:assert/strict";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { createRoot } from "react-dom/client";
import { FrameControls } from "./FrameControls.jsx";
import { useCanvasStore } from "../../lib/canvas-store.js";
import { emptyCanvasState } from "../../lib/canvas/serialization.js";

const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
const frame = (id, extra = {}) => ({ id, type: "frame", x: 0, y: 0, w: 300, h: 200, name: id, fill: "transparent", stroke: "#000", parentId: null, groupId: null, ...extra });

test("a locked frame offers only its copies, an unlocked one its size and hiding too", async () => {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost", pretendToBeVisual: true });
  const names = ["window", "document", "HTMLElement", "Node", "React", "IS_REACT_ACT_ENVIRONMENT", "fetch"];
  const prior = Object.fromEntries(names.map((name) => [name, globalThis[name]]));
  const data = { ...emptyCanvasState(), nodes: [frame("open"), frame("held", { x: 500, locked: true })] };
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, React, IS_REACT_ACT_ENVIRONMENT: true,
    fetch: async (url, init = {}) => (init.method || "GET") === "PUT"
      ? json({ ok: true, updatedAt: Date.now() })
      : json({ id: "board-1", name: "B", data, updatedAt: 1, role: "co_owner" }) });
  useCanvasStore.getState().reset();
  await useCanvasStore.getState().loadBoard("board-1");
  const root = createRoot(document.querySelector("#root"));
  const controls = () => [...document.querySelectorAll("[role=toolbar] select, [role=toolbar] button")].map((el) => el.getAttribute("aria-label") || el.textContent.trim());
  try {
    await act(async () => useCanvasStore.getState().setSelection(["open"]));
    await act(async () => root.render(React.createElement(FrameControls)));
    assert.deepEqual(controls(), ["Frame size", "Hide frame", "Copies"]);
    await act(async () => useCanvasStore.getState().setSelection(["held"]));
    assert.deepEqual(controls(), ["Copies"]);
  } finally {
    await act(async () => root.unmount());
    useCanvasStore.getState().reset();
    Object.assign(globalThis, prior);
    dom.window.close();
  }
});
