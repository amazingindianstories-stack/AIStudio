import test from "node:test";
import assert from "node:assert/strict";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { createRoot } from "react-dom/client";
import { DetailModal } from "./DetailModal.jsx";
import { useStore } from "../lib/store.js";
import { __setMediaResolverFetch } from "../lib/media-resolver.js";

const image = (id, extra = {}) => ({
  id, kind: "image", status: "succeeded", model: "Nano Banana", prompt: id,
  aspectRatio: "1:1", filename: `${id}.png`, url: `/api/media/generations/${id}.png`, ...extra,
});

test("the feed viewer never preloads the master of a neighbouring row whose stored media is missing", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost", pretendToBeVisual: true });
  const names = ["window", "document", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement", "Image", "React", "IS_REACT_ACT_ENVIRONMENT", "ResizeObserver", "IntersectionObserver", "requestAnimationFrame", "cancelAnimationFrame"];
  const previous = Object.fromEntries(names.map((name) => [name, globalThis[name]]));
  for (const name of names.filter((name) => name.startsWith("HTML"))) globalThis[name] = dom.window[name];
  const warmed = [];
  Object.assign(globalThis, {
    window: dom.window, document: dom.window.document, React, IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (cb) => setTimeout(cb, 0), cancelAnimationFrame: clearTimeout,
    ResizeObserver: class { observe() {} disconnect() {} },
    IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
    Image: class { set src(url) { warmed.push(url); } },
  });
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const resolved = [];
  __setMediaResolverFetch(async (_path, options) => {
    resolved.push(...JSON.parse(options.body).items.map((entry) => entry.ref));
    return { ok: true, json: async () => ({ items: [] }) };
  });
  const original = useStore.getState();
  const missing = image("missing", { mediaMissingAt: 1790000000000 });
  useStore.setState({
    activeId: "shown", activeSource: "feed", rightTab: "global",
    items: [image("shown"), missing, image("after")], threadItems: [], looseItems: [],
    selectedIds: [], libraryTree: { globalFolders: [], projects: [] },
  });
  const root = createRoot(document.getElementById("root"));
  try {
    await act(async () => root.render(React.createElement(DetailModal)));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 60)));
    const requested = [...resolved, ...warmed];
    assert.ok(requested.includes("/api/media/generations/after.png"), "the present neighbour is still preloaded");
    assert.ok(!requested.includes(missing.url), "the missing row's master is never requested");
  } finally {
    await act(async () => root.unmount());
    useStore.setState(original, true);
    Object.assign(globalThis, previous);
    dom.window.close();
  }
});
