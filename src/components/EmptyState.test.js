import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { Library } from "lucide-react";
import EmptyState from "./EmptyState.jsx";
import { AdminErrorsTab } from "./AdminErrorsTab.jsx";
import { AdminAiUsageTab } from "./AdminAiUsageTab.jsx";
import { AdminBoardLogsTab } from "./AdminBoardLogsTab.jsx";
import { TopBar } from "./TopBar.jsx";
import { useStore } from "../lib/store.js";

globalThis.React = React;

test("EmptyState renders icon, title, hint and action", () => {
  const html = renderToStaticMarkup(
    React.createElement(EmptyState, { icon: Library, title: "No provider errors", hint: "No errors match these filters.", action: React.createElement("button", null, "Clear") })
  );
  assert.match(html, /<svg[^>]*aria-hidden/);
  assert.match(html, /<h3[^>]*>No provider errors<\/h3>/);
  assert.match(html, /No errors match these filters\./);
  assert.match(html, /<button>Clear<\/button>/);
});

test("EmptyState omits hint and icon when absent", () => {
  const html = renderToStaticMarkup(React.createElement(EmptyState, { title: "T" }));
  assert.doesNotMatch(html, /<svg|<p/);
});

async function mount(element, respond, run) {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost", pretendToBeVisual: true });
  const keys = ["window", "document", "HTMLElement", "Element", "Node", "fetch", "React", "IS_REACT_ACT_ENVIRONMENT", "requestAnimationFrame", "cancelAnimationFrame"];
  const before = Object.fromEntries(keys.map((key) => [key, globalThis[key]]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element,
    Node: dom.window.Node, React, IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: (fn) => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout,
    fetch: async (url) => new Response(JSON.stringify(respond(String(url))), { status: 200, headers: { "Content-Type": "application/json" } }) });
  dom.window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
  const root = createRoot(document.querySelector("#root"));
  try {
    await act(async () => root.render(element));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    await run();
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, before);
    dom.window.close();
  }
}

const headings = () => [...document.querySelectorAll("h3")].map((h) => h.textContent);

test("an admin errors tab with no matching rows shows the shared empty state", async () => {
  await mount(React.createElement(AdminErrorsTab, { data: { users: [] }, usersById: {} }), () => ({ rows: [], total: 0, nextCursor: null, providers: [], models: [] }), async () => {
    assert.ok(headings().includes("No provider errors"));
    assert.match(document.body.textContent, /No errors match these filters\./);
  });
});

test("the AI usage tab with no jobs shows the shared empty state for periods and actions", async () => {
  const usage = { days: 30, totalCents: 0, periods: [], formats: [], users: [] };
  await mount(React.createElement(AdminAiUsageTab), () => ({ usage }), async () => {
    assert.equal(headings().filter((title) => title === "No board AI spend yet").length, 3);
  });
});

test("the board logs tab with no entries shows the shared empty state", async () => {
  await mount(React.createElement(AdminBoardLogsTab), () => ({ rows: [], nextCursor: null }), async () => {
    assert.ok(headings().includes("No board activity yet"));
    assert.match(document.body.textContent, /Entries appear here as boards are used\./);
  });
});

test("phone nav buttons carry a title and the depth dot names the worker state", async () => {
  const original = useStore.getState();
  for (const [status, label] of [[null, "Checking depth worker status"], [{ online: true }, "Depth worker online"], [{ online: false }, "Depth worker offline"]]) {
    useStore.setState({ currentUser: null, depthWorkerStatus: status, loadDepthWorkerStatus: async () => {}, view: "studio", mode: "image" });
    try {
      await mount(React.createElement(TopBar), () => ({}), async () => {
        const nav = document.querySelector("nav[aria-label='Sections']");
        for (const button of nav.querySelectorAll("button[aria-label]")) {
          assert.equal(button.getAttribute("title"), button.getAttribute("aria-label"));
        }
        const depth = nav.querySelector("button[aria-label='Depth']");
        assert.ok(depth, "the Depth destination is shown");
        assert.equal(depth.querySelector("[role=img]").getAttribute("aria-label"), label);
      });
    } finally {
      useStore.setState(original, true);
    }
  }
});
