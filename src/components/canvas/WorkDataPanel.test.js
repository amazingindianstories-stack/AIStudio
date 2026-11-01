import test from "node:test";
import assert from "node:assert/strict";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { createRoot } from "react-dom/client";
import { WorkDataPanel } from "./WorkDataPanel.jsx";
import { useCanvasStore } from "../../lib/canvas-store.js";

const fields = [
  { id: "title", name: "Title", type: "text" },
  { id: "status", name: "Status", type: "select", options: ["To do", "Doing", "Done"] },
];
const table = { id: "t1", name: "Sprint", fields, views: [], canEdit: true, ownerOnly: false, version: 3 };
const record = { id: "r1", parentId: null, blockedBy: [], version: 2, cells: { title: "Ship", status: "In progress" } };

test("record details keep a value whose select option was renamed and save it unchanged", async () => {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost" });
  const names = ["window", "document", "HTMLElement", "Node", "React", "IS_REACT_ACT_ENVIRONMENT", "fetch"];
  const prior = Object.fromEntries(names.map((name) => [name, globalThis[name]]));
  const posted = [];
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, React,
    IS_REACT_ACT_ENVIRONMENT: true,
    fetch: async (url, options = {}) => {
      if (options.method === "POST") { posted.push(JSON.parse(options.body)); return Response.json({ record }); }
      if (String(url).includes("/work/t1")) return Response.json({ table, records: [record], total: 1, offset: 0, limit: 100, aggregates: {}, groups: [] });
      return Response.json({ users: [] });
    } });
  useCanvasStore.setState({ boardId: "b1" });
  const root = createRoot(document.querySelector("#root"));
  const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
  try {
    await act(async () => { root.render(React.createElement(WorkDataPanel, { node: { id: "n1", kind: "table", datasetId: "t1" }, onClose: () => {} })); await settle(); });
    await act(async () => { document.querySelector("tbody button").click(); await settle(); });
    const status = [...document.querySelectorAll('form[aria-label="Record details"] label')].find((label) => label.textContent.startsWith("Status")).querySelector("select");
    assert.equal(status.value, "In progress");
    assert.equal(status.selectedOptions[0].textContent, "In progress (removed)");
    assert.deepEqual([...status.options].map((option) => option.value), ["", "To do", "Doing", "Done", "In progress"]);

    await act(async () => { document.querySelector('form[aria-label="Record details"] button[type="submit"]').click(); await settle(); });
    assert.equal(posted.at(-1).cells.status, "In progress");
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, prior);
    dom.window.close();
  }
});
