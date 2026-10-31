import test from "node:test";
import assert from "node:assert/strict";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { createRoot } from "react-dom/client";
import { WorkRecordViews } from "./WorkRecordViews.jsx";

const ADA = "a0a2d000-0000-4000-8000-000000000001";
const GONE = "f0f2d000-0000-4000-8000-000000000009";
const fields = [
  { id: "title", name: "Title", type: "text" },
  { id: "description", name: "Description", type: "text" },
  { id: "status", name: "Status", type: "select", options: ["To do", "In progress", "Done"] },
  { id: "assignee", name: "Assignee", type: "people" },
  { id: "start", name: "Start date", type: "date" },
  { id: "cost", name: "Cost per point", type: "formula", expression: "budget / points" },
];
const records = [
  { id: "1", parentId: null, cells: { title: "Ship", description: "", status: "In progress", assignee: ADA, start: "", cost: 33.333333333333336 } },
  { id: "2", parentId: null, cells: { title: "Plan", status: "Done", assignee: GONE, cost: 116.66666666666667 } },
];

test("work views show people by name, round formulas and omit empty card fields; chart labels stay whole", async () => {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost" });
  const names = ["window", "document", "HTMLElement", "Node", "React", "IS_REACT_ACT_ENVIRONMENT", "fetch"];
  const prior = Object.fromEntries(names.map((name) => [name, globalThis[name]]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, React,
    IS_REACT_ACT_ENVIRONMENT: true,
    fetch: async () => new Response(JSON.stringify({ users: [{ id: ADA, name: "Ada Lovelace", email: "ada@example.test" }] }), { headers: { "Content-Type": "application/json" } }) });
  const root = createRoot(document.querySelector("#root"));
  const render = (props) => act(async () => {
    root.render(React.createElement(WorkRecordViews, { records, fields, ...props }));
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  const texts = (selector) => [...document.querySelectorAll(selector)].map((node) => node.textContent);
  try {
    await render({ kind: "kanban" });
    const [ship] = [...document.querySelectorAll("button")].filter((card) => card.textContent.startsWith("Ship"));
    assert.deepEqual([...ship.querySelectorAll("div")].map((line) => line.textContent), ["Status: In progress", "Assignee: Ada Lovelace", "Cost per point: 33.33"]);

    await render({ kind: "kanban", view: { groupBy: "assignee" } });
    assert.deepEqual(texts("h4"), ["Ada Lovelace", GONE.slice(0, 8)]);

    await render({ kind: "table" });
    const cells = [...document.querySelectorAll("tbody tr")].map((row) => [...row.querySelectorAll("td")].map((cell) => cell.textContent));
    assert.deepEqual(cells.map((row) => [row[3], row[5]]), [["Ada Lovelace", "33.33"], [GONE.slice(0, 8), "116.67"]]);
    assert.equal(document.querySelector("tbody td:nth-child(6)").getAttribute("title"), "33.33");
    assert.ok(!document.body.textContent.includes(ADA));

    await render({ kind: "chart", view: { groupBy: "status" }, groups: [{ value: "In progress", count: 2 }, { value: "Done", count: 1 }] });
    const labels = [...document.querySelectorAll("svg text")];
    assert.deepEqual(labels.map((label) => label.textContent), ["In progress", "Done"]);
    assert.ok(labels.every((label) => !label.getAttribute("transform")));

    await render({ kind: "chart", view: { groupBy: "assignee" }, groups: [{ value: ADA, count: 2 }, { value: "", count: 1 }] });
    assert.deepEqual(texts("svg text"), ["Ada Lovelace", "Unassigned"]);
    assert.ok(document.body.textContent.includes("Legend: Ada Lovelace · Unassigned"));

    // Without a valid saved value field, the chart plots the first number field, as the server does.
    await render({ kind: "chart", view: { valueField: "deleted" } });
    assert.deepEqual(texts("svg title"), ["Ship: 33.333333333333336", "Plan: 116.66666666666667"]);
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, prior);
    dom.window.close();
  }
});
