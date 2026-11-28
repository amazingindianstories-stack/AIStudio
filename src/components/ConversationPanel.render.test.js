import test from "node:test";
import assert from "node:assert/strict";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { createRoot } from "react-dom/client";
import { useStore } from "../lib/store.js";
import { FeedBlock } from "./ConversationPanel.jsx";
import { __setMediaResolverFetch } from "../lib/media-resolver.js";

const names = ["window", "document", "HTMLElement", "React", "IS_REACT_ACT_ENVIRONMENT", "fetch", "ResizeObserver", "IntersectionObserver", "requestAnimationFrame", "cancelAnimationFrame"];

test("a thread card whose stored master is missing shows File missing, opens no viewer and offers no download", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost", pretendToBeVisual: true });
  const prior = Object.fromEntries(names.map((n) => [n, globalThis[n]]));
  Object.assign(globalThis, {
    window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, React, IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (cb) => setTimeout(cb, 0), cancelAnimationFrame: (id) => clearTimeout(id),
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
  });
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  __setMediaResolverFetch(async () => ({ ok: true, status: 200, json: async () => ({ items: [] }) }));
  const original = useStore.getState();
  const opened = [];
  const image = { id: "m1", kind: "image", aspectRatio: "1:1", status: "succeeded", prompt: "m1", filename: "m1.png", url: "/api/media/generations/m1.png", createdAt: 1, mediaMissingAt: 1234 };
  const video = { ...image, id: "m2", kind: "video", filename: "m2.mov", url: "/api/media/generations/m2.mov", poster: "/api/media/thumbs/poster/generations/m2.mov.webp" };
  useStore.setState({ currentUser: { id: "u", role: "admin" }, items: [image, video], usersById: {}, setActiveId: (id) => opened.push(id) });
  const root = createRoot(document.querySelector("#root"));
  try {
    await act(async () => root.render(React.createElement("div", null,
      React.createElement(FeedBlock, { item: image, index: 1 }),
      React.createElement(FeedBlock, { item: video, index: 2 }))));
    const tiles = [...document.querySelectorAll('[data-testid="media-missing-tile"]')];
    assert.equal(tiles.length, 2);
    const srcs = [...document.querySelectorAll("img, video")].map((node) => node.getAttribute("src"));
    assert.deepEqual(srcs, ["/api/media/thumbs/512/generations/m1.png.webp"]);
    assert.equal(document.querySelectorAll("a[download]").length, 0);
    assert.equal(document.querySelectorAll('[draggable="true"]').length, 0);
    await act(async () => { document.querySelectorAll(".chat-media").forEach((media) => media.click()); });
    assert.deepEqual(opened, []);
    assert.equal(document.querySelectorAll('[aria-label="Add to favourites"]').length, 2);
  } finally {
    await act(async () => root.unmount());
    useStore.setState(original, true);
    Object.assign(globalThis, prior);
    dom.window.close();
  }
});
