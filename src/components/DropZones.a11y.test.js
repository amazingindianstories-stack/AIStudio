import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { createRoot } from "react-dom/client";
import { useStore } from "../lib/store";
import { UpscalerComposer } from "./UpscalerComposer.jsx";
import { VideoUpscalerComposer } from "./VideoUpscalerComposer.jsx";
import { DepthComposer } from "./DepthComposer.jsx";

async function withComposer(Component, state, run) {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost", pretendToBeVisual: true });
  const keys = ["window", "document", "HTMLElement", "File", "requestAnimationFrame", "cancelAnimationFrame", "React", "IS_REACT_ACT_ENVIRONMENT", "fetch", "KeyboardEvent"];
  const previous = Object.fromEntries(keys.map((key) => [key, globalThis[key]]));
  const previousStore = useStore.getState();
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, File: dom.window.File, React,
    IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: (fn) => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout, KeyboardEvent: dom.window.KeyboardEvent,
    fetch: async () => new Response(JSON.stringify({}), { status: 200 }) });
  dom.window.HTMLElement.prototype.attachEvent = dom.window.HTMLElement.prototype.detachEvent = () => {};
  useStore.setState({ depthWorkerStatus: { online: true, workerCount: 1, queueDepth: 0 }, loadDepthWorkerStatus: async () => {}, generating: false,
    upscalerImage: null, upscalerVideo: null, ...state });
  const root = createRoot(document.querySelector("#root"));
  try {
    await act(async () => root.render(React.createElement(Component)));
    await run();
  } finally {
    await act(async () => root.unmount());
    useStore.setState(previousStore, true);
    for (const key of keys) globalThis[key] = previous[key];
    dom.window.close();
  }
}

// Tab to the drop zone and press Enter or Space: the hidden file input is clicked.
async function assertKeyboardOpensChooser() {
  const zone = document.querySelector('[role="button"][tabindex="0"]');
  assert.ok(zone, "drop zone is a focusable button");
  assert.match(zone.textContent, /Drop/);
  const input = document.querySelector("input[type=file]");
  let clicks = 0;
  input.click = () => { clicks += 1; };
  for (const key of ["Enter", " "]) {
    await act(async () => zone.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })));
  }
  assert.equal(clicks, 2);
  await act(async () => zone.dispatchEvent(new window.KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true })));
  assert.equal(clicks, 2);
}

// Each button group (models, scale, resolution) reports exactly one pressed button.
function assertModelTabsPressed() {
  const first = document.querySelector("button[aria-pressed]");
  const group = [...first.parentElement.querySelectorAll("button[aria-pressed]")];
  assert.ok(group.length >= 2);
  assert.equal(group.filter((tab) => tab.getAttribute("aria-pressed") === "true").length, 1);
}

test("image upscaler drop zone opens the file chooser from the keyboard and model tabs report pressed", async () => {
  await withComposer(UpscalerComposer, {}, async () => {
    await assertKeyboardOpensChooser();
    assertModelTabsPressed();
  });
});

test("video upscaler drop zone opens the file chooser from the keyboard and model tabs report pressed", async () => {
  await withComposer(VideoUpscalerComposer, {}, async () => {
    await assertKeyboardOpensChooser();
    assertModelTabsPressed();
  });
});

test("depth drop zone opens the file chooser from the keyboard and its error is announced", async () => {
  await withComposer(DepthComposer, {}, async () => {
    await assertKeyboardOpensChooser();
    const input = document.querySelector("input[type=file]");
    const bad = new window.File(["x"], "notes.txt", { type: "text/plain" });
    Object.defineProperty(input, "files", { configurable: true, value: [bad] });
    await act(async () => input.dispatchEvent(new window.Event("change", { bubbles: true })));
    const alert = document.querySelector('[role="alert"]');
    assert.ok(alert && alert.textContent.trim(), "depth error has role=alert");
  });
});
