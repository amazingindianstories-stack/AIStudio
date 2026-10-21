import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { createRoot } from "react-dom/client";
import { useStore } from "../lib/store";
import { AssetGrid } from "./AssetGrid.jsx";

test("a batched sentinel callback pages on its newest entry, not its first", async () => {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost" });
  const keys = ["window", "document", "HTMLElement", "ResizeObserver", "IntersectionObserver", "React", "IS_REACT_ACT_ENVIRONMENT"];
  const before = Object.fromEntries(keys.map((key) => [key, globalThis[key]]));
  const previous = useStore.getState();
  const observers = [];
  Object.assign(globalThis, {
    window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    ResizeObserver: class { observe() {} disconnect() {} },
    IntersectionObserver: class {
      constructor(callback) { this.callback = callback; this.live = true; observers.push(this); }
      observe(target) { this.target = target; }
      disconnect() { this.live = false; }
    },
    React, IS_REACT_ACT_ENVIRONMENT: true,
  });
  let pages = 0;
  useStore.setState({ hasMoreHistory: true, loadMoreHistory: async () => { pages += 1; } });
  const items = Array.from({ length: 20 }, (_, index) => ({ id: `row-${index}`, kind: "image", status: "succeeded", aspectRatio: "3:2" }));
  const root = createRoot(document.querySelector("#root"));
  try {
    await act(async () => root.render(React.createElement(AssetGrid, {
      items, loading: false, cardWidth: 180, empty: null,
      renderItem: (item) => React.createElement("div", { "data-asset-card-id": item.id }),
    })));
    const sentinel = observers.filter((observer) => observer.live).at(-1);
    assert.ok(sentinel?.target);
    // Chromium delivered exactly this after a search was cleared: the sentinel
    // left and re-entered the margin before the callback ran. It stays inside
    // afterwards, so this is the only notification the grid will get.
    await act(async () => sentinel.callback([
      { target: sentinel.target, isIntersecting: false },
      { target: sentinel.target, isIntersecting: true },
    ]));
    assert.equal(pages, 1);
  } finally {
    await act(async () => root.unmount());
    useStore.setState(previous, true);
    for (const key of keys) globalThis[key] = before[key];
    dom.window.close();
  }
});
