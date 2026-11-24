import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { createRoot } from "react-dom/client";
import { SettingsToolbar } from "./ComposerControls.jsx";
import { useStore } from "../lib/store";

async function harness(run) {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost", pretendToBeVisual: true });
  const names = ["window", "document", "HTMLElement", "Node", "React", "IS_REACT_ACT_ENVIRONMENT", "ResizeObserver", "requestAnimationFrame",
    "cancelAnimationFrame", "getComputedStyle"];
  const prior = Object.fromEntries(names.map((name) => [name, globalThis[name]]));
  const observer = class { observe() {} unobserve() {} disconnect() {} };
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, React,
    IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: (fn) => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout, ResizeObserver: observer,
    getComputedStyle: dom.window.getComputedStyle });
  const previous = useStore.getState();
  const root = createRoot(document.querySelector("#root"));
  try {
    await run({ root });
  } finally {
    await act(async () => root.unmount());
    useStore.setState(previous, true);
    Object.assign(globalThis, prior);
    dom.window.close();
  }
}

test("the destination chip sits at the row end with ml-auto, after the other chips, which keep their wrapping layout", async () => {
  await harness(async ({ root }) => {
    await act(async () => root.render(React.createElement(SettingsToolbar)));
    const toolbar = document.querySelector(".composer-toolbar");
    assert.ok(toolbar.className.includes("flex-wrap"), "the toolbar still wraps");
    const chips = [...toolbar.children];
    const destination = chips[chips.length - 1];
    assert.ok(destination.classList.contains("composer-destination"));
    assert.ok(destination.classList.contains("ml-auto"), "destination is pushed to the row end");
    assert.ok(destination.querySelector("button[aria-label='Generation destination'], button"));
    const others = chips.slice(0, -1);
    assert.ok(others.length >= 2, "model and settings chips precede it");
    for (const chip of others) assert.ok(!chip.classList.contains("ml-auto"), "other chips are unchanged");
    assert.ok(chips.find((c) => c.classList.contains("composer-settings")));
    const focusable = [...toolbar.querySelectorAll("button")];
    assert.ok(destination.contains(focusable[focusable.length - 1]), "destination is last in tab order");
  });
});

test("without a destination the toolbar renders no destination chip", async () => {
  await harness(async ({ root }) => {
    await act(async () => root.render(React.createElement(SettingsToolbar, { destination: false })));
    assert.equal(document.querySelector(".composer-destination"), null);
  });
});

test("the toolbar ignores unrelated store changes but still follows its own fields (FE-015)", async () => {
  await harness(async ({ root }) => {
    let renders = 0;
    const onRender = () => { renders += 1; };
    await act(async () => root.render(React.createElement(React.Profiler, { id: "toolbar", onRender }, React.createElement(SettingsToolbar))));
    const before = renders;
    assert.ok(before >= 1);
    await act(async () => { useStore.setState({ unrelatedField: 1 }); });
    assert.equal(renders, before, "an unrelated field must not re-render the toolbar");
    await act(async () => { useStore.setState({ aspectRatio: useStore.getState().aspectRatio === "1:1" ? "16:9" : "1:1" }); });
    assert.ok(renders > before, "its own field still does");
  });
});
