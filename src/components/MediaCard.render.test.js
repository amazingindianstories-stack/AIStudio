import test from "node:test";
import assert from "node:assert/strict";
import React, { act, Profiler } from "react";
import { JSDOM } from "jsdom";
import { createRoot } from "react-dom/client";
import { useStore } from "../lib/store.js";
import { MediaCard, resolveGenerationFolder } from "./MediaCard.jsx";
import { __setMediaResolverFetch } from "../lib/media-resolver.js";

const names = ["window", "document", "HTMLElement", "React", "IS_REACT_ACT_ENVIRONMENT", "fetch", "ResizeObserver", "IntersectionObserver", "requestAnimationFrame", "cancelAnimationFrame", "KeyboardEvent"];

const card = (id, folderId) => ({ id, kind: "image", aspectRatio: "1:1", status: "succeeded", prompt: id, filename: `${id}.png`, url: `/api/media/${id}`, folderId, createdAt: 1 });
const tree = (renamed = "B") => ({
  globalFolders: [{ id: "a", name: "A", children: [] }, { id: "b", name: renamed, children: [{ id: "c", name: "C", children: [] }] }],
  projects: [],
});

test("a card does not re-render for store changes it does not read", async () => {
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
  const items = [card("i1", "a"), card("i2", "b"), card("i3", "c")];
  useStore.setState({ currentUser: { id: "u", role: "admin" }, items, selectedIds: [], usersById: {}, libraryTree: tree() });
  const renders = { i1: 0, i2: 0, i3: 0 };
  const root = createRoot(document.querySelector("#root"));
  try {
    await act(async () => root.render(React.createElement("div", null, items.map((item) =>
      React.createElement(Profiler, { key: item.id, id: item.id, onRender: () => { renders[item.id] += 1; } },
        React.createElement(MediaCard, { item, selectable: true }))))));
    const base = { ...renders };
    assert.ok(base.i1 > 0);

    // Unrelated field: nobody re-renders.
    await act(async () => useStore.setState({ prompt: "something else" }));
    assert.deepEqual(renders, base);

    // Renaming folder "A" re-renders only the card that lives in it... which here is i1 only if its label changed.
    await act(async () => useStore.setState({ libraryTree: tree("B2") }));
    assert.equal(renders.i1, base.i1, "i1 folder label unchanged");
    assert.ok(renders.i2 > base.i2, "i2 folder was renamed");
    assert.ok(renders.i3 > base.i3, "i3 path includes the renamed folder");
  } finally {
    await act(async () => root.unmount());
    useStore.setState(original, true);
    Object.assign(globalThis, prior);
    dom.window.close();
  }
});

test("resolveGenerationFolder resolves nested, project and missing folders", () => {
  const t = { ...tree(), projects: [{ id: "p", name: "Proj", folders: [{ id: "x", name: "X", children: [{ id: "y", name: "Y" }] }] }] };
  assert.deepEqual(resolveGenerationFolder({ folderId: "c" }, t), { label: "Global / B / C", navigable: true });
  assert.deepEqual(resolveGenerationFolder({ projectId: "p", folderId: "y" }, t), { label: "Proj / X / Y", navigable: true });
  assert.deepEqual(resolveGenerationFolder({ projectId: "p", folderId: "c" }, t), { label: "Proj / Folder unavailable", navigable: false });
  assert.deepEqual(resolveGenerationFolder({ projectId: "zz" }, t), { label: "Project unavailable", navigable: false });
  assert.deepEqual(resolveGenerationFolder({}, undefined), { label: "Global / Unsorted", navigable: true });
});

test("a succeeded card with a missing master shows a File missing tile that never requests the master", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost", pretendToBeVisual: true });
  const prior = Object.fromEntries(names.map((n) => [n, globalThis[n]]));
  const requested = [];
  Object.assign(globalThis, {
    window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, React, IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (cb) => setTimeout(cb, 0), cancelAnimationFrame: (id) => clearTimeout(id),
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
    fetch: async (url) => { requested.push(String(url)); return { ok: true, status: 200, json: async () => ({}) }; },
  });
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  __setMediaResolverFetch(async (url) => { requested.push(String(url)); return { ok: true, status: 200, json: async () => ({ items: [] }) }; });
  const original = useStore.getState();
  const image = { ...card("m1", "a"), url: "/api/media/generations/m1.png", mediaMissingAt: 1234 };
  const video = { ...card("m2", "a"), kind: "video", url: "/api/media/generations/m2.mov", poster: "/api/media/thumbs/poster/generations/m2.mov.webp", mediaMissingAt: 1234 };
  useStore.setState({ currentUser: { id: "u", role: "admin" }, items: [image, video], selectedIds: [], usersById: {}, libraryTree: tree() });
  const root = createRoot(document.querySelector("#root"));
  try {
    await act(async () => root.render(React.createElement("div", null,
      React.createElement(MediaCard, { item: image, selectable: true }),
      React.createElement(MediaCard, { item: video, selectable: true }))));
    const tiles = [...document.querySelectorAll('[data-testid="media-missing-tile"]')];
    assert.equal(tiles.length, 2);
    assert.ok(tiles.every((tile) => tile.textContent.includes("File missing")));
    // Image: only the surviving 512 derivative is requested, and when it fails the tile falls back to the plain placeholder.
    const imageImgs = [...tiles[0].querySelectorAll("img")];
    assert.deepEqual(imageImgs.map((img) => img.getAttribute("src")), ["/api/media/thumbs/512/generations/m1.png.webp"]);
    await act(async () => { imageImgs[0].dispatchEvent(new dom.window.Event("error")); });
    assert.equal(tiles[0].querySelectorAll("img").length, 0);
    assert.match(tiles[0].textContent, /File missing/);
    // Video: a plain placeholder, with no <img>, <video> or master request.
    assert.equal(tiles[1].querySelectorAll("img").length, 0);
    assert.equal(document.querySelectorAll("video").length, 0);
    assert.equal(document.querySelectorAll(".media-card-body img").length, 0);
    assert.deepEqual(requested.filter((url) => url.includes("generations/m1.png") && !url.includes("thumbs/512")), []);
    assert.deepEqual(requested.filter((url) => url.includes("m2.mov")), []);
  } finally {
    await act(async () => root.unmount());
    useStore.setState(original, true);
    Object.assign(globalThis, prior);
    dom.window.close();
  }
});
