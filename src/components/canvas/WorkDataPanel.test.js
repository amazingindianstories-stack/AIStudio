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
const records = [
  { id: "r1", parentId: null, blockedBy: [], version: 2, cells: { title: "Ship", status: "In progress" } },
  { id: "r2", parentId: null, blockedBy: [], version: 1, cells: { title: "Plan", status: "To do" } },
];
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

async function withPanel(kind, body) {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost" });
  const names = ["window", "document", "HTMLElement", "Node", "React", "IS_REACT_ACT_ENVIRONMENT", "fetch"];
  const prior = Object.fromEntries(names.map((name) => [name, globalThis[name]]));
  const posted = [];
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, React,
    IS_REACT_ACT_ENVIRONMENT: true,
    fetch: async (url, options = {}) => {
      if (options.method === "POST") {
        const op = JSON.parse(options.body);
        posted.push(op);
        if (op.op === "settings") return Response.json({ error: "Table changed. Refresh before saving." }, { status: 409 });
        return Response.json({ record: records[0] });
      }
      if (String(url).includes("/work/t1")) return Response.json({ table, records, total: records.length, offset: 0, limit: 100, aggregates: {}, groups: [] });
      return Response.json({ users: [] });
    } });
  useCanvasStore.setState({ boardId: "b1" });
  const root = createRoot(document.querySelector("#root"));
  try {
    await act(async () => { root.render(React.createElement(WorkDataPanel, { node: { id: `n-${kind}`, kind, datasetId: "t1" }, onClose: () => {} })); await settle(); });
    await body({ dom, posted });
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, prior);
    dom.window.close();
  }
}

test("record details keep a value whose select option was renamed and save it unchanged", () => withPanel("table", async ({ posted }) => {
  await act(async () => { document.querySelector("tbody button").click(); await settle(); });
  const status = [...document.querySelectorAll('form[aria-label="Record details"] label')].find((label) => label.textContent.startsWith("Status")).querySelector("select");
  assert.equal(status.value, "In progress");
  assert.equal(status.selectedOptions[0].textContent, "In progress (removed)");
  assert.deepEqual([...status.options].map((option) => option.value), ["", "To do", "Doing", "Done", "In progress"]);

  await act(async () => { document.querySelector('form[aria-label="Record details"] button[type="submit"]').click(); await settle(); });
  assert.equal(posted.at(-1).cells.status, "In progress");
}));

test("dropping a card on a removed option's column explains the refusal; its own records and current options still move", () => withPanel("kanban", async ({ dom, posted }) => {
  const drop = (column, id) => act(async () => {
    const target = [...document.querySelectorAll("h4")].find((h) => h.textContent === column).parentElement;
    const event = new dom.window.Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: { getData: () => id } });
    target.dispatchEvent(event);
    await settle();
  });
  assert.deepEqual([...document.querySelectorAll("h4")].map((h) => h.textContent), ["To do", "Doing", "Done", "In progress"]);

  await drop("In progress", "r2");
  assert.equal(posted.length, 0);
  assert.equal(document.querySelector('[role="alert"]').textContent, '"In progress" is no longer a Status option. Choose a current option.');

  await drop("Doing", "r2");
  await drop("In progress", "r1");
  assert.deepEqual(posted.map((op) => [op.id, op.cells.status]), [["r2", "Doing"], ["r1", "In progress"]]);
  assert.equal(document.querySelector('[role="alert"]'), null);
}));

test("a rejected fields and settings save shows its error inside the settings dialog that covers the panel", () => withPanel("table", async () => {
  const button = (root, text) => [...root.querySelectorAll("button")].find((b) => b.textContent === text);
  await act(async () => { button(document, "Fields and settings").click(); await settle(); });
  const settings = document.querySelector('[aria-label="Table fields and settings"]');
  await act(async () => { button(settings, "Save fields and settings").click(); await settle(); });

  assert.equal(settings.querySelector('[role="alert"]')?.textContent, "Table changed. Refresh before saving.");
  assert.equal(document.querySelectorAll('[role="alert"]').length, 1);
  assert.ok(document.querySelector('[aria-label="Table fields and settings"]'), "the dialog stays open so the edits are not lost");
}));
