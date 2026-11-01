import test from "node:test";
import assert from "node:assert/strict";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { createRoot } from "react-dom/client";
import { LayersPanel } from "./LayersPanel.jsx";
import { useCanvasStore } from "../../lib/canvas-store.js";
import { emptyCanvasState } from "../../lib/canvas/serialization.js";

function useDom(t) {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost", pretendToBeVisual: true });
  const names = ["window", "document", "HTMLElement", "React", "IS_REACT_ACT_ENVIRONMENT", "requestAnimationFrame", "cancelAnimationFrame", "getComputedStyle", "ResizeObserver"];
  const prior = Object.fromEntries(names.map((name) => [name, globalThis[name]]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, React,
    IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: (fn) => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout,
    getComputedStyle: dom.window.getComputedStyle, ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } });
  dom.window.HTMLElement.prototype.scrollIntoView = function () {};
  t.after(() => Object.assign(globalThis, prior));
}

// The item in the menu opened last.
const item = (name) => [...[...document.querySelectorAll("[role=menu]")].at(-1).querySelectorAll("[role=menuitem]")]
  .find((el) => el.textContent.includes(name));
const red = (el) => [el, ...el.querySelectorAll("*")].some((child) => /\btext-red-/.test(child.getAttribute("class") ?? ""));

test("Delete layer dims like other disabled items on a locked layer and is red when enabled", async (t) => {
  useDom(t);
  const original = useCanvasStore.getState();
  t.after(() => useCanvasStore.setState(original, true));
  const layers = [{ id: "open", name: "Open layer" }, { id: "shut", name: "Shut layer", locked: true }];
  useCanvasStore.setState({ boardRole: "owner", accessLost: false, selection: [],
    history: { ...original.history, present: { ...emptyCanvasState(), settings: { layers } } } });
  const root = createRoot(document.querySelector("#root"));
  await act(async () => root.render(React.createElement(LayersPanel, { onClose() {} })));
  const open = async (name) => act(async () => document.querySelector(`button[aria-label='More for ${name}']`).click());

  await open("Shut layer");
  assert.equal(item("Delete layer").disabled, true);
  assert.equal(red(item("Delete layer")), false, "a disabled Delete layer must not keep its destructive red");

  await open("Open layer");
  assert.equal(item("Delete layer").disabled, false);
  assert.equal(red(item("Delete layer")), true);
  await act(async () => root.unmount());
});
