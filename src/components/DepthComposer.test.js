import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { createRoot } from "react-dom/client";
import { useStore } from "../lib/store";
import { DepthComposer } from "./DepthComposer.jsx";

test("depth composer accepts a picked video and reaches the upload step", async () => {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost" });
  const keys = ["window", "document", "HTMLElement", "File", "requestAnimationFrame", "cancelAnimationFrame", "React", "IS_REACT_ACT_ENVIRONMENT", "fetch"];
  const previous = Object.fromEntries(keys.map((key) => [key, globalThis[key]]));
  const previousStore = useStore.getState();
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, File: dom.window.File, React,
    IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: (fn) => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout,
    fetch: async () => new Response(JSON.stringify({ error: "UPLOAD_QUOTA_EXCEEDED" }), { status: 400, headers: { "Content-Type": "application/json" } }) });
  const requests = [];
  useStore.setState({ depthWorkerStatus: { online: true, workerCount: 1, queueDepth: 0 }, loadDepthWorkerStatus: async () => {},
    generating: false, generateDepthMap: async (args) => { requests.push(args); return { id: "d1" }; } });
  const root = createRoot(document.querySelector("#root"));
  try {
    await act(async () => root.render(React.createElement(DepthComposer)));
    const input = document.querySelector("input[type=file]");
    const video = new dom.window.File(["fake"], "shot.mov", { type: "video/quicktime" });
    Object.defineProperty(input, "files", { configurable: true, value: [video] });
    await act(async () => input.dispatchEvent(new dom.window.Event("change", { bubbles: true })));
    assert.ok(document.body.textContent.includes("shot.mov"), "picked video is shown");
    assert.ok(!document.body.textContent.includes("not defined"));
    const generate = Array.from(document.querySelectorAll("button")).find((el) => el.textContent.includes("Generate depth map"));
    assert.ok(generate && !generate.disabled, "Generate is enabled while the worker is online");
    await act(async () => generate.click());
    for (let i = 0; i < 100 && !document.body.textContent.includes("Upload limit reached"); i++) {
      await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
    }
    // The upload helper ran (and got the stubbed server refusal) instead of throwing a ReferenceError.
    assert.ok(document.body.textContent.includes("Upload limit reached"), document.body.textContent.slice(0, 400));
    assert.ok(!document.body.textContent.includes("not defined"));
    assert.deepEqual(requests, [], "no depth job is created when the upload fails");
  } finally {
    await act(async () => root.unmount());
    useStore.setState(previousStore, true);
    for (const key of keys) globalThis[key] = previous[key];
  }
});
