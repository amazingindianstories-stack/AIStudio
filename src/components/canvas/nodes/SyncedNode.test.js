import test from "node:test";
import assert from "node:assert/strict";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { createRoot } from "react-dom/client";
import { SyncedNode } from "./SyncedNode.jsx";
import { clearSyncedCache } from "../../../lib/synced-frames.js";

const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

test("a synced copy whose source frame holds a copy of itself draws that copy as an outline instead of nesting without end", async () => {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost", pretendToBeVisual: true });
  const names = ["window", "document", "HTMLElement", "Node", "React", "IS_REACT_ACT_ENVIRONMENT", "fetch"];
  const prior = Object.fromEntries(names.map((name) => [name, globalThis[name]]));
  const copy = { id: "s", type: "synced", x: 20, y: 20, w: 200, h: 100, sourceBoardId: "board-a", sourceNodeId: "f", name: "Loop", parentId: "f", groupId: null };
  const source = { id: "f", type: "frame", x: 0, y: 0, w: 400, h: 200, name: "Scene", fill: "transparent", stroke: "#000", parentId: null, groupId: null };
  const calls = [];
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, React, IS_REACT_ACT_ENVIRONMENT: true,
    fetch: async (url) => {
      calls.push(String(url));
      return json({ board: { id: "board-a", name: "Board A", projectId: "p" }, version: 1, frame: source, nodes: [source, copy], connectors: [] });
    } });
  clearSyncedCache();
  const root = createRoot(document.querySelector("#root"));
  try {
    await act(async () => root.render(React.createElement(SyncedNode, { node: { ...copy, id: "outer", parentId: null } })));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    assert.match(document.body.textContent, /Board A: Scene/);
    assert.equal(document.querySelectorAll("[data-synced-id]").length, 1);
    assert.match(document.body.textContent, /Loop/);
    assert.equal(calls.length, 1);
  } finally {
    await act(async () => root.unmount());
    clearSyncedCache();
    Object.assign(globalThis, prior);
    dom.window.close();
  }
});
