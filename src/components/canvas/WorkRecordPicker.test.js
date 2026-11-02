import test from "node:test";
import assert from "node:assert/strict";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { createRoot } from "react-dom/client";
import { WorkRecordPicker } from "./WorkRecordPicker.jsx";

const PATH = "/api/canvas-boards/board/work/table";
const BLOCKER = "11111111-1111-4111-8111-111111111111";
const NEEDED = "22222222-2222-4222-8222-222222222222";
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

test("the Blocked by picker looks up only complete record ids and clears a lookup error once a lookup succeeds", async () => {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost" });
  const names = ["window", "document", "HTMLElement", "Node", "React", "IS_REACT_ACT_ENVIRONMENT", "fetch"];
  const prior = Object.fromEntries(names.map((name) => [name, globalThis[name]]));
  const lookups = [];
  let failing = true;
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, React,
    IS_REACT_ACT_ENVIRONMENT: true,
    fetch: async (url) => {
      const ids = new URL(url, "http://localhost").searchParams.get("ids").split(",");
      lookups.push(ids);
      if (failing) return json(503, { error: "Table is busy." });
      return json(200, { records: ids.map((id) => ({ id, cells: { title: id === BLOCKER ? "Design review" : "Write brief" } })) });
    } });
  const root = createRoot(document.querySelector("#root"));
  const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  const render = (needs) => act(async () => root.render(React.createElement(WorkRecordPicker, {
    path: PATH, label: "Blocked by", multiple: true, value: [BLOCKER], onChange() {}, fixed: needs.map((id) => ({ id, source: "Needs" })) })));
  const alert = () => document.querySelector("[role=alert]")?.textContent || "";
  const entries = () => [...document.querySelectorAll("[aria-label='Blocked by records'] li")].map((item) => item.textContent);
  try {
    await render([]);
    await settle();
    assert.deepEqual(lookups, [[BLOCKER]]);
    assert.equal(alert(), "Table is busy.");
    failing = false;
    for (let end = 1; end < NEEDED.length; end += 1) await render([NEEDED.slice(0, end)]);
    await settle();
    assert.equal(lookups.length, 1);
    assert.equal(entries().length, 1);
    await render([NEEDED]);
    await settle();
    assert.deepEqual(lookups.at(-1), [BLOCKER, NEEDED]);
    assert.equal(lookups.length, 2);
    assert.equal(alert(), "");
    assert.deepEqual(entries(), ["Design reviewRemove", "Write briefFrom Needs field"]);
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, prior);
    dom.window.close();
  }
});
