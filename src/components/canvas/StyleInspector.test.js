import test from "node:test";
import assert from "node:assert/strict";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { createRoot } from "react-dom/client";
import { StyleInspector } from "./StyleInspector.jsx";
import { useCanvasStore } from "../../lib/canvas-store.js";
import { useStore } from "../../lib/store.js";
import { emptyCanvasState } from "../../lib/canvas/serialization.js";

function withDom() {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost", pretendToBeVisual: true });
  const names = ["window", "document", "HTMLElement", "React", "IS_REACT_ACT_ENVIRONMENT", "requestAnimationFrame", "cancelAnimationFrame",
    "getComputedStyle", "ResizeObserver", "localStorage"];
  const prior = Object.fromEntries(names.map((name) => [name, globalThis[name]]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, React,
    IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: (fn) => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout,
    getComputedStyle: dom.window.getComputedStyle, ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    localStorage: dom.window.localStorage });
  dom.window.HTMLElement.prototype.scrollIntoView = function () {};
  return () => Object.assign(globalThis, prior);
}

const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
const sticky = (id, extra = {}) => ({ id, type: "sticky", x: 0, y: 0, w: 200, h: 200, text: id, fill: "#e3c56a", fontSize: 16,
  color: "#1c1a12", opacity: 1, parentId: null, groupId: null, ...extra });

async function openInspector(t, role, nodes, props = {}) {
  const restoreDom = withDom();
  const data = { ...emptyCanvasState(), nodes };
  t.mock.method(globalThis, "fetch", async () => json({ id: "board-1", name: "Board", data, updatedAt: 1, role }));
  useStore.setState({ currentUser: { id: "u1" } });
  useCanvasStore.getState().reset();
  await useCanvasStore.getState().loadBoard("board-1");
  useCanvasStore.getState().setSelection(nodes.map((n) => n.id));
  const root = createRoot(document.querySelector("#root"));
  await act(async () => root.render(React.createElement(StyleInspector, props)));
  t.after(async () => {
    await act(async () => root.unmount());
    useCanvasStore.getState().reset();
    useStore.setState({ currentUser: null });
    restoreDom();
  });
}

const reactions = () => useCanvasStore.getState().history.present.nodes.map((n) => n.reactions);

const openPicker = () => act(async () => document.querySelector("[aria-label='React']").closest("button").click());
const vote = () => act(async () => {
  thumbs().click();
  await new Promise((resolve) => setTimeout(resolve, 0));
});
const thumbs = () => [...document.querySelectorAll("[data-reaction-picker] button")].find((b) => b.textContent === "👍");

test("a locked selection of stickies still takes a first vote, skipping a protected lock someone else holds", async (t) => {
  await openInspector(t, "edit", [sticky("plain", { locked: true }), sticky("theirs", { locked: true, lockedBy: "u2", lockProtected: true })]);
  assert.ok(document.querySelector("[data-locked-toolbar]"), "the locked bar shows");
  await openPicker();
  assert.equal(thumbs().getAttribute("aria-pressed"), "false");
  await vote();
  assert.deepEqual(reactions(), [{ "👍": ["u1"] }, undefined]);
});

test("the picker shows this person's vote as given when only a held sticky lacks it, and takes it back", async (t) => {
  await openInspector(t, "edit", [sticky("plain", { locked: true, reactions: { "👍": ["u1"] } }),
    sticky("theirs", { locked: true, lockedBy: "u2", lockProtected: true })]);
  await openPicker();
  assert.equal(thumbs().getAttribute("aria-pressed"), "true");
  await vote();
  assert.deepEqual(reactions(), [undefined, undefined]);
});

test("no vote control shows when every selected sticky is under a protected lock someone else holds", async (t) => {
  await openInspector(t, "edit", [sticky("theirs", { locked: true, lockedBy: "u2", lockProtected: true })]);
  assert.ok(document.querySelector("[data-locked-toolbar]"));
  assert.equal(document.querySelector("[aria-label='React']"), null);
});

test("with room under the board's top bar, the panel sits above the selection", async (t) => {
  useCanvasStore.getState().setViewportSize(1600, 900);
  await openInspector(t, "edit", [sticky("high", { y: 400 })], { insetTop: 180 });
  const top = parseFloat(document.querySelector("[data-center-x]").style.top);
  assert.ok(top >= 180 && top + 44 <= 400, `above the selection, under the bar: ${top}`);
});

test("a selection just under the top bar puts the panel below it, not over the bar", async (t) => {
  useCanvasStore.getState().setViewportSize(1600, 900);
  await openInspector(t, "edit", [sticky("near", { y: 150 })], { insetTop: 180 });
  assert.ok(parseFloat(document.querySelector("[data-center-x]").style.top) >= 350, "below the selection");
});

test("a tall selection under the top bar keeps the panel on the canvas, just under the bar", async (t) => {
  useCanvasStore.getState().setViewportSize(1600, 900);
  await openInspector(t, "edit", [sticky("tall", { y: 150, h: 800 })], { insetTop: 180 });
  assert.equal(parseFloat(document.querySelector("[data-center-x]").style.top), 180);
});
