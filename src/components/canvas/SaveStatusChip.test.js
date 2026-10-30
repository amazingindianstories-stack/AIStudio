import test from "node:test";
import assert from "node:assert/strict";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { createRoot } from "react-dom/client";
import { SaveStatusChip } from "./CanvasView.jsx";
import { useCanvasStore } from "../../lib/canvas-store.js";
import { emptyCanvasState } from "../../lib/canvas/serialization.js";

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const rect = (id) => ({ id, type: "rect", x: 0, y: 0, w: 10, h: 10, parentId: null, groupId: null, fill: "#ffffff", stroke: "#000000", strokeWidth: 1, cornerRadius: 0 });
const board = { id: "board-1", projectId: "p", name: "Board", role: "edit", createdBy: null, createdAt: 1, updatedAt: 1, version: 1, data: { ...emptyCanvasState(), nodes: [rect("a")] } };

/** Renders the chip from the store's save state after one save answered with `status`. */
async function chipAfterSave(t, status) {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost", pretendToBeVisual: true });
  const names = ["window", "document", "HTMLElement", "Node", "React", "IS_REACT_ACT_ENVIRONMENT", "localStorage"];
  const prior = Object.fromEntries(names.map((name) => [name, globalThis[name]]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, React,
    IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(globalThis, "localStorage", { value: dom.window.localStorage, configurable: true, writable: true });
  const root = createRoot(document.querySelector("#root"));
  t.after(async () => {
    await act(async () => root.unmount());
    useCanvasStore.getState().reset();
    for (const name of names) Object.defineProperty(globalThis, name, { value: prior[name], configurable: true, writable: true });
    dom.window.close();
  });
  t.mock.method(globalThis, "fetch", async (url, init = {}) => (init.method === "PUT" || init.method === "PATCH" ? json(status, { error: "Refused." }) : json(200, board)));
  useCanvasStore.getState().reset();
  await useCanvasStore.getState().loadBoard("board-1");
  useCanvasStore.getState().addNode(rect("big"));
  await useCanvasStore.getState().flushSave();
  const { saveStatus, saveError } = useCanvasStore.getState();
  await act(async () => root.render(React.createElement(SaveStatusChip, { status: saveStatus, error: saveError, onRetry: () => {} })));
  const chip = document.querySelector("#root > div");
  return { text: chip.textContent, retry: [...chip.querySelectorAll("button")].some((button) => button.textContent === "Retry") };
}

test("a board refused as too large says so and offers no retry that cannot succeed", async (t) => {
  const chip = await chipAfterSave(t, 413);
  assert.equal(chip.text, "Board too large to save - remove some items and try again");
  assert.equal(chip.retry, false);
});

test("any other failed save still says it is retrying and offers Retry", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const chip = await chipAfterSave(t, 500);
  assert.equal(chip.text, "Could not save - retryingRetry");
  assert.equal(chip.retry, true);
});
