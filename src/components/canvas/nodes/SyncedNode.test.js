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

test("a synced copy of a diagram draws its content and connectors, without its header or what is on a layer the diagram hides", async () => {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost", pretendToBeVisual: true });
  const names = ["window", "document", "HTMLElement", "Node", "React", "IS_REACT_ACT_ENVIRONMENT", "fetch"];
  const prior = Object.fromEntries(names.map((name) => [name, globalThis[name]]));
  const link = (id, from, to) => ({ id, from: { nodeId: from }, to: { nodeId: to }, kind: "arrow", shape: "straight", stroke: "#fff", strokeWidth: 2 });
  const layers = [{ id: "main", name: "Main", visible: true }, { id: "draft", name: "Draft", visible: false }];
  const source = { id: "d", type: "diagram", x: 0, y: 0, w: 400, h: 200, name: "Flow", layers, fill: "transparent", stroke: "#000", strokeWidth: 2, parentId: null, groupId: null };
  const sticky = (id, layer, x = 20) => ({ id, type: "sticky", x, y: 20, w: 80, h: 80, text: id, fill: "#fff59d", fontSize: 16, color: "#000", parentId: "d", groupId: null, diagramLayerId: layer });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, React, IS_REACT_ACT_ENVIRONMENT: true,
    fetch: async () => json({ board: { id: "board-a", name: "Board A", projectId: "p" }, version: 1, frame: source,
      nodes: [source, sticky("shown", "main"), sticky("next", "main", 260), sticky("drafted", "draft", 140)],
      connectors: [link("c1", "shown", "next"), link("c2", "shown", "drafted")] }) });
  clearSyncedCache();
  const root = createRoot(document.querySelector("#root"));
  try {
    const copy = { id: "outer", type: "synced", x: 0, y: 0, w: 200, h: 100, sourceBoardId: "board-a", sourceNodeId: "d", name: "Flow", parentId: null, groupId: null };
    await act(async () => root.render(React.createElement(SyncedNode, { node: copy })));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    assert.match(document.body.textContent, /Board A: Flow/);
    // The copy's badge names the diagram; its header and controls, which a copy cannot use, are not drawn.
    assert.doesNotMatch(document.body.textContent, /Diagram|Focus mode|Main/);
    assert.equal(document.querySelectorAll("[data-synced-id] button").length, 1);
    assert.deepEqual([...document.querySelectorAll("[data-node-id]")].map((el) => el.getAttribute("data-node-id")), ["d", "shown", "next"]);
    const drawn = [...document.querySelectorAll("[data-connector-id]")];
    assert.deepEqual(drawn.map((el) => el.getAttribute("data-connector-id")), ["c1"]);
    const points = drawn[0].querySelector("path").getAttribute("d").match(/-?\d+(\.\d+)?/g).map(Number);
    const [startX, startY] = points.slice(0, 2);
    const [endX, endY] = points.slice(-2);
    assert.deepEqual([startX, startY, endX, endY].map(Math.round), [100, 20, 260, 20]);
  } finally {
    await act(async () => root.unmount());
    clearSyncedCache();
    Object.assign(globalThis, prior);
    dom.window.close();
  }
});
