import test from "node:test";
import assert from "node:assert/strict";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { createRoot } from "react-dom/client";
import { CanvasView } from "./CanvasView.jsx";
import { useStore } from "../../lib/store.js";
import { useCanvasStore } from "../../lib/canvas-store.js";

const BOARD = { id: "board-1", projectId: "project", name: "Storyboard", createdBy: "me", createdAt: 1, updatedAt: 1, teamRole: "edit", role: "owner",
  version: 1, data: { nodes: [], connectors: [], viewport: { x: 0, y: 0, zoom: 1 } } };
const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

async function emptyBoard(run) {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost", pretendToBeVisual: true });
  const names = ["window", "document", "HTMLElement", "Node", "React", "IS_REACT_ACT_ENVIRONMENT", "fetch", "ResizeObserver", "IntersectionObserver",
    "requestAnimationFrame", "cancelAnimationFrame", "getComputedStyle", "MutationObserver", "localStorage"];
  const prior = Object.fromEntries(names.map((name) => [name, globalThis[name]]));
  const observer = class { observe() {} unobserve() {} disconnect() {} };
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, React,
    IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: (fn) => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout,
    MutationObserver: dom.window.MutationObserver, localStorage: dom.window.localStorage, ResizeObserver: observer, IntersectionObserver: observer,
    getComputedStyle: dom.window.getComputedStyle });
  dom.window.matchMedia = (query) => ({ matches: query !== "(pointer: coarse)", addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
  dom.window.HTMLElement.prototype.scrollIntoView = function () {};
  globalThis.fetch = async (url) => {
    const path = String(url);
    if (path.startsWith("/api/canvas-boards?")) return json({ boards: [BOARD], canCreate: true });
    if (path.startsWith("/api/canvas-boards/board-1")) return json(BOARD);
    if (path.startsWith("/api/assets")) return json({ assets: [], items: [] });
    if (path === "/api/board-notifications") return json({ notifications: [], preferences: {} });
    return json({});
  };
  const original = useStore.getState();
  useStore.setState({ activeProjectId: "project", projects: [{ id: "project", name: "Project" }], items: [], assets: [], currentUser: { id: "me", role: "user" } });
  const root = createRoot(document.querySelector("#root"));
  const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  try {
    await act(async () => root.render(React.createElement(CanvasView)));
    await settle();
    await settle();
    await run(settle);
  } finally {
    await act(async () => root.unmount());
    useCanvasStore.getState().reset();
    await act(async () => useStore.setState(original, true));
    Object.assign(globalThis, prior);
    dom.window.close();
  }
}

const button = (label) => [...document.querySelectorAll("button")].find((element) => element.textContent.trim() === label);
const phone = (element, ...classes) => classes.every((name) => element.classList.contains(name));

test("on phones the board header is one horizontally scrolling row", async () => {
  await emptyBoard(async () => {
    const row = button("Share").parentElement;
    assert.ok(phone(row, "max-sm:flex-nowrap", "max-sm:overflow-x-auto"));
    for (const label of ["Board", "Facilitate", "Talktrack"]) assert.ok(row.contains(button(label)), `${label} sits in the scrolling row`);
  });
});

test("every header menu escapes the scrolling row on phones instead of being clipped by it", async () => {
  await emptyBoard(async (settle) => {
    for (const label of ["Board", "Facilitate", "Talktrack"]) {
      await act(async () => button(label).click());
      await settle();
      const menu = button(label).parentElement.querySelector("[role=menu]");
      assert.ok(menu, `${label} opens its menu`);
      assert.ok(phone(menu, "max-sm:fixed", "max-sm:left-4", "max-sm:right-4", "max-sm:w-auto"), `${label} menu is fixed to the viewport on phones`);
      await act(async () => button(label).click());
      assert.equal(button(label).parentElement.querySelector("[role=menu]"), null, `${label} closes`);
    }
  });
});

test("an empty board shows phone copy that does not point at a missing left panel", async () => {
  await emptyBoard(async () => {
    const copy = [...document.querySelectorAll("span")];
    const desktop = copy.find((span) => span.textContent === "Pick a tool below, or drag an asset from the left to start your storyboard.");
    const touch = copy.find((span) => span.textContent === "Tap + to add a card or asset.");
    assert.ok(desktop && phone(desktop, "max-sm:hidden"), "the desktop copy hides on phones");
    assert.ok(touch && phone(touch, "hidden", "max-sm:inline"), "the phone copy shows only on phones");
  });
});
