import test from "node:test";
import assert from "node:assert/strict";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { createRoot } from "react-dom/client";
import { BoardHistoryPanel } from "./BoardHistoryPanel.jsx";
import { ObjectInfo } from "./ObjectInfo.jsx";
import { useCanvasStore } from "../../lib/canvas-store.js";
import { emptyCanvasState } from "../../lib/canvas/serialization.js";

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const ANA = "11111111-1111-4111-8111-111111111111";
const BEN = "22222222-2222-4222-8222-222222222222";
const USERS = { users: [{ id: ANA, name: "Ana Rao", email: "ana@example.com", color: "#f472b6" }, { id: BEN, name: "", email: "ben@example.com" }] };
const sticky = (id, extra = {}) => ({ id, type: "sticky", x: 100, y: 50, w: 200, h: 200, parentId: null, groupId: null, text: "", fill: "#fff59d", fontSize: 16, color: "#000000", ...extra });

async function harness(server, run) {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost", pretendToBeVisual: true });
  const names = ["window", "document", "HTMLElement", "Node", "React", "IS_REACT_ACT_ENVIRONMENT", "fetch"];
  const prior = Object.fromEntries(names.map((name) => [name, globalThis[name]]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, React,
    IS_REACT_ACT_ENVIRONMENT: true });
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url) === "/api/users") return json(200, USERS);
    return server(String(url)) ?? json(404, { error: "Not found." });
  };
  const root = createRoot(document.querySelector("#root"));
  const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  try {
    await run({ root, calls, settle });
  } finally {
    await act(async () => root.unmount());
    useCanvasStore.getState().reset();
    Object.assign(globalThis, prior);
    dom.window.close();
  }
}

function loadGraph(nodes, connectors = []) {
  useCanvasStore.setState({ boardId: "board-1", loaded: true, boardRole: "edit", serverVersion: 3,
    history: { past: [], present: { ...emptyCanvasState(), nodes, connectors }, future: [] } });
}

const buttons = (label) => [...document.querySelectorAll("button")].filter((button) => button.textContent.includes(label));

test("the history panel groups changes by person with snippets, jumps to objects still on the board and loads older pages", async () => {
  const now = Date.now();
  const first = { activity: [
    { actorId: ANA, action: "edit", nodeId: "s1", nodeType: "sticky", snippet: "Shot list for day two", at: now - 1000 },
    { actorId: ANA, action: "add", nodeId: "gone", nodeType: "frame", snippet: "Act 1", at: now - 2000 },
    { actorId: BEN, action: "delete", nodeId: "old", nodeType: "connector", snippet: null, at: now - 3000 },
  ], next: `${now - 3000}.0` };
  const older = { activity: [{ actorId: BEN, action: "add", nodeId: "s1", nodeType: "sticky", snippet: null, at: now - 9000 }], next: null };
  await harness((url) => (url.includes("before=") ? json(200, older) : url.endsWith("/activity") ? json(200, first) : null), async ({ root, calls, settle }) => {
    loadGraph([sticky("s1", { text: "Shot list for day two" })]);
    let closed = 0;
    await act(async () => root.render(React.createElement(BoardHistoryPanel, { boardId: "board-1", onClose: () => { closed += 1; } })));
    await settle();
    const panel = document.querySelector("[aria-label='Board history']");
    assert.ok(panel);
    const text = panel.textContent;
    assert.match(text, /Ana Rao/);
    assert.match(text, /ben@example\.com/, "a person without a name shows by email");
    assert.match(text, /Edited sticky note/);
    assert.match(text, /“Shot list for day two”/);
    assert.match(text, /Added frame/);
    assert.match(text, /Deleted connector/);
    assert.equal(panel.querySelectorAll("ol > li").length, 2, "Ana's two changes form one group, Ben's another");

    // Only the object still on the board can be jumped to.
    assert.equal(buttons("Edited sticky note").length, 1);
    assert.equal(buttons("Added frame").length, 0);
    assert.equal(buttons("Deleted connector").length, 0);
    await act(async () => buttons("Edited sticky note")[0].click());
    assert.deepEqual(useCanvasStore.getState().selection, ["s1"]);
    const { viewport } = useCanvasStore.getState().history.present;
    assert.ok(viewport.x < 200 && viewport.x + 1600 / viewport.zoom > 200, "the view is centered on the sticky");

    await act(async () => buttons("Load older changes")[0].click());
    await settle();
    assert.ok(calls.some((url) => url === `/api/canvas-boards/board-1/activity?before=${encodeURIComponent(`${now - 3000}.0`)}`));
    assert.match(panel.textContent, /Added sticky note/);
    assert.equal(buttons("Load older changes").length, 0, "no more pages");

    await act(async () => document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    assert.equal(closed, 1);
  });
});

test("a save while the panel is open adds the newer changes on top of the pages already loaded", async () => {
  const now = Date.now();
  let pages = [{ activity: [{ actorId: ANA, action: "add", nodeId: "s1", nodeType: "sticky", snippet: null, at: now - 5000 }], next: null }];
  await harness((url) => (url.endsWith("/activity") ? json(200, pages[0]) : null), async ({ root, settle }) => {
    loadGraph([sticky("s1")]);
    await act(async () => root.render(React.createElement(BoardHistoryPanel, { boardId: "board-1", onClose() {} })));
    await settle();
    pages = [{ activity: [
      { actorId: BEN, action: "edit", nodeId: "s1", nodeType: "sticky", snippet: "New text", at: now - 100 },
      { actorId: ANA, action: "add", nodeId: "s1", nodeType: "sticky", snippet: null, at: now - 5000 },
    ], next: null }];
    await act(async () => useCanvasStore.setState({ serverVersion: 4 }));
    await settle();
    const items = [...document.querySelectorAll("[aria-label='Board history'] ul > li")].map((item) => item.textContent);
    assert.equal(items.length, 2);
    assert.match(items[0], /Edited sticky note/);
    assert.match(items[1], /Added sticky note/);
  });
});

test("history that cannot load says so and offers a retry", async () => {
  let fail = true;
  await harness((url) => (url.endsWith("/activity") ? (fail ? json(403, { error: "Forbidden." }) : json(200, { activity: [], next: null })) : null), async ({ root, settle }) => {
    loadGraph([]);
    await act(async () => root.render(React.createElement(BoardHistoryPanel, { boardId: "board-1", onClose() {} })));
    await settle();
    assert.match(document.body.textContent, /History could not be loaded/);
    fail = false;
    await act(async () => buttons("Try again")[0].click());
    await settle();
    assert.match(document.body.textContent, /No changes recorded yet/);
  });
});

test("object info names who created and last changed the one selected object", async () => {
  const now = Date.now();
  await harness(() => null, async ({ root, settle }) => {
    loadGraph([
      sticky("both", { createdBy: ANA, createdAt: now - 10 * 60_000, updatedBy: BEN, updatedAt: now - 2 * 60_000 }),
      sticky("new", { createdBy: ANA, createdAt: now - 1000, updatedBy: ANA, updatedAt: now - 1000 }),
      sticky("legacy"),
      sticky("touched", { updatedBy: BEN, updatedAt: now - 1000 }),
    ], [{ id: "c1", from: { nodeId: "both", anchor: "auto" }, to: { x: 0, y: 0 }, kind: "arrow", stroke: "#000", strokeWidth: 2, createdBy: BEN, createdAt: now - 1000, updatedBy: BEN, updatedAt: now - 1000 }]);
    await act(async () => root.render(React.createElement(ObjectInfo)));
    await settle();
    const info = () => document.querySelector("[aria-label='Object info']")?.textContent ?? null;
    assert.equal(info(), null, "nothing selected");

    await act(async () => useCanvasStore.getState().setSelection(["both"]));
    assert.match(info(), /Created by Ana Rao · 10 min ago/);
    assert.match(info(), /Last changed by ben@example\.com · 2 min ago/);

    await act(async () => useCanvasStore.getState().setSelection(["new"]));
    assert.match(info(), /^Created by Ana Rao · just now$/, "an unchanged object shows only its creation");

    await act(async () => useCanvasStore.getState().setSelection(["legacy"]));
    assert.equal(info(), null, "an object from before stamping shows nothing");

    await act(async () => useCanvasStore.getState().setSelection(["touched"]));
    assert.match(info(), /^Last changed by ben@example\.com · just now$/);

    await act(async () => useCanvasStore.getState().setSelection(["both", "new"]));
    assert.equal(info(), null, "several objects selected");

    await act(async () => useCanvasStore.setState({ selection: [], selectedConnectorIds: ["c1"] }));
    assert.match(info(), /Created by ben@example\.com/);
  });
});
