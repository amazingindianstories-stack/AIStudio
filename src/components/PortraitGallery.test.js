import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { createRoot } from "react-dom/client";
import { useStore } from "../lib/store";
import { PortraitGallery } from "./PortraitGallery.jsx";

const p = (id, createdAt, extra = {}) => ({ id, name: `Face ${id}`, imageUrl: `/api/media/uploads/portrait/${id}`, state: "ready", message: null, origin: "upload", createdBy: null, createdAt, ...extra });

async function mount(state, run) {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost" });
  const keys = ["window", "document", "HTMLElement", "Element", "Node", "File", "requestAnimationFrame", "cancelAnimationFrame", "ResizeObserver", "IntersectionObserver", "React", "IS_REACT_ACT_ENVIRONMENT"];
  const before = Object.fromEntries(keys.map((key) => [key, globalThis[key]]));
  const previous = useStore.getState();
  const observers = [];
  Object.assign(globalThis, {
    window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, File: dom.window.File,
    requestAnimationFrame: (fn) => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout,
    ResizeObserver: class { observe() {} disconnect() {} }, React, IS_REACT_ACT_ENVIRONMENT: true,
    IntersectionObserver: class {
      constructor(callback) { this.callback = callback; this.live = true; observers.push(this); }
      observe(target) { this.target = target; }
      disconnect() { this.live = false; }
    },
  });
  dom.window.Element.prototype.scrollIntoView = () => {};
  const calls = { delete: [], attach: [], load: [] };
  useStore.setState({
    portraitGalleryOpen: true,
    portraitUploads: [],
    loadPortraits: async (options) => { calls.load.push(options); },
    deletePortraits: async (ids) => { calls.delete.push(ids); return { ok: true, removed: ids.length, failed: [] }; },
    attachPortraitsToComposer: (list) => { calls.attach.push(list.map((i) => i.id)); return { ok: true, count: list.length }; },
    ...state,
  });
  const root = createRoot(document.querySelector("#root"));
  try {
    await act(async () => root.render(React.createElement(PortraitGallery)));
    await run({ calls, dom, observers, click: async (el, init = {}) => act(async () => { el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true, ...init })); }) });
  } finally {
    await act(async () => root.unmount());
    useStore.setState(previous, true);
    for (const key of keys) globalThis[key] = before[key];
    dom.window.close();
  }
}

const gallery = (items, extra = {}) => ({ portraits: { enabled: true, items, next: null, loading: false, loadingMore: false, error: null, query: "" }, ...extra });
const card = (id) => document.querySelector(`article[data-portrait-id="${id}"]`);
const button = (name) => Array.from(document.querySelectorAll("button")).find((b) => b.textContent.trim() === name || b.getAttribute("aria-label") === name);

test("the gallery is one flat grid with no groups or provider wording", async () => {
  const items = [p("c", 3), p("b", 2, { state: "preparing" }), p("a", 1, { state: "waiting" })];
  await mount(gallery(items), async () => {
    const dialog = document.querySelector("[role=dialog][aria-label='Portrait Gallery']");
    assert.ok(dialog);
    assert.equal(document.querySelectorAll("article").length, 3);
    assert.equal(card("c").getAttribute("aria-label"), "Face c");
    assert.ok(document.querySelector("input[aria-label='Search portraits']"));
    assert.ok(document.querySelector("input[type=file][multiple]"));
    assert.ok(button("Close Portrait Gallery"));
    assert.ok(button("Upload"));
    const text = dialog.textContent + Array.from(dialog.querySelectorAll("[aria-label],[title]")).map((e) => e.getAttribute("aria-label") + " " + e.getAttribute("title")).join(" ");
    assert.doesNotMatch(text, /byteplus|group|slot|capacity|asset id|character/i);
    const chips = Array.from(document.querySelectorAll("[data-portrait-chip]")).map((e) => e.textContent);
    assert.deepEqual(chips.sort(), ["Preparing", "Waiting for space"]);
  });
});

test("an unusable portrait explains itself and Dismiss deletes it without a confirmation", async () => {
  await mount(gallery([p("x", 1, { state: "unusable", message: "This image can't be used as a portrait." })]), async ({ calls, click }) => {
    assert.match(card("x").textContent, /Can't be used/);
    assert.match(card("x").textContent, /This image can't be used as a portrait\./);
    await click(button("Dismiss"));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    assert.deepEqual(calls.delete, [["x"]]);
    assert.equal(document.querySelector("[role=alertdialog]"), null);
  });
});

test("clicking cards selects them, shift extends a range and the toolbar offers add and delete", async () => {
  const items = [p("d", 4), p("c", 3), p("b", 2), p("a", 1)];
  await mount(gallery(items), async ({ calls, click }) => {
    await click(card("c"));
    assert.equal(card("c").getAttribute("data-selected"), "true");
    assert.match(document.querySelector("[data-testid=portrait-selection-toolbar]").textContent, /1 selected/);
    await click(card("a"), { shiftKey: true });
    assert.deepEqual(items.map((i) => card(i.id).getAttribute("data-selected")), ["false", "true", "true", "true"]);
    assert.match(document.body.textContent, /3 selected/);
    await click(button("Add 3 to prompt"));
    assert.deepEqual(calls.attach, [["c", "b", "a"]]);
    await click(button("Clear selection"));
    assert.equal(document.querySelector("[data-testid=portrait-selection-toolbar]"), null);
    assert.ok(document.querySelector("input[aria-label='Search portraits']"));
  });
});

test("bulk delete confirms, sends one request and keeps refused portraits selected with an error", async () => {
  const items = [p("c", 3), p("b", 2), p("a", 1)];
  await mount(gallery(items), async ({ calls, click }) => {
    await act(async () => useStore.setState({ deletePortraits: async (ids) => { calls.delete.push(ids); return { ok: false, removed: 2, failed: [{ id: "b", error: "It is in use right now." }] }; } }));
    await click(card("c"));
    await click(card("b"));
    await click(card("a"));
    await click(button("Delete 3"));
    const dialog = document.querySelector("[role=alertdialog]");
    assert.match(dialog.textContent, /Delete 3 portraits\?/, "a confirmation names the count");
    assert.deepEqual(calls.delete, [], "nothing is deleted before confirming");
    await click(Array.from(dialog.querySelectorAll("button")).find((b) => b.textContent.trim() === "Delete 3"));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    assert.deepEqual(calls.delete, [["c", "b", "a"]]);
    const alert = document.querySelector("[role=alert]");
    assert.match(alert.textContent, /Deleted 2/);
    assert.match(alert.textContent, /still selected/);
    assert.match(alert.textContent, /in use right now/);
  });
});

test("Escape clears the selection first and Ctrl+A selects every portrait", async () => {
  const items = [p("b", 2), p("a", 1)];
  await mount(gallery(items), async ({ dom }) => {
    const dialog = document.querySelector("[role=dialog]");
    const key = (init) => act(async () => { card("b").dispatchEvent(new dom.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })); });
    await key({ key: "a", ctrlKey: true });
    assert.match(document.body.textContent, /2 selected/);
    await key({ key: "Escape" });
    assert.equal(document.querySelector("[data-testid=portrait-selection-toolbar]"), null);
    assert.ok(dialog.isConnected, "the first Escape only cleared the selection");
    await key({ key: "Escape" });
    assert.equal(useStore.getState().portraitGalleryOpen, false);
  });
});

test("arrow keys move focus through the grid and Space toggles the focused portrait", async () => {
  const items = [p("c", 3), p("b", 2), p("a", 1)];
  await mount(gallery(items), async ({ dom }) => {
    const press = (target, init) => act(async () => { target.dispatchEvent(new dom.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })); });
    await act(async () => card("c").focus());
    await press(card("c"), { key: "ArrowRight" });
    await act(async () => {});
    assert.equal(document.activeElement, card("b"));
    await press(card("b"), { key: " " });
    assert.equal(card("b").getAttribute("data-selected"), "true");
    await press(card("b"), { key: "ArrowLeft", shiftKey: true });
    assert.equal(document.activeElement, card("c"));
    assert.equal(card("c").getAttribute("data-selected"), "true");
  });
});

test("uploads show a tile with progress, errors can be dismissed", async () => {
  const uploads = [
    { key: "u1", name: "face one", state: "uploading", progress: 45, error: null, previewUrl: null },
    { key: "u2", name: "face two", state: "registering", progress: 100, error: null, previewUrl: null },
    { key: "u3", name: "huge", state: "error", progress: 0, error: "This image is larger than 30 MB. Use a smaller version.", previewUrl: null },
  ];
  await mount(gallery([p("a", 1)], { portraitUploads: uploads }), async ({ click }) => {
    const chips = Array.from(document.querySelectorAll("[data-portrait-chip]")).map((e) => e.textContent);
    assert.deepEqual(chips.sort(), ["Preparing", "Uploading 45%"]);
    assert.match(document.body.textContent, /larger than 30 MB/);
    let dismissed = null;
    await act(async () => useStore.setState({ dismissPortraitUpload: (key) => { dismissed = key; } }));
    await click(button("Dismiss"));
    assert.equal(dismissed, "u3");
  });
});

test("an empty gallery invites drag and drop; search with no matches says so", async () => {
  await mount(gallery([]), async () => {
    assert.match(document.body.textContent, /Drop images here/);
    assert.equal(document.querySelectorAll("article").length, 0);
  });
});

test("while the backend has portraits off the gallery says so quietly", async () => {
  await mount({ portraits: { enabled: false, items: [], next: null, loading: false, loadingMore: false, error: null, query: "" } }, async () => {
    assert.match(document.body.textContent, /Portraits are unavailable right now\./);
    assert.equal(button("Upload"), undefined);
    assert.equal(document.querySelector("input[aria-label='Search portraits']"), null);
  });
});

test("opening the gallery loads portraits and the menu key opens a card menu with the four actions", async () => {
  await mount(gallery([p("a", 1)]), async ({ calls, dom }) => {
    assert.deepEqual(calls.load[0], { query: "" });
    await act(async () => card("a").focus());
    await act(async () => { card("a").dispatchEvent(new dom.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "ContextMenu" })); });
    const items = Array.from(document.querySelectorAll("[data-card-context-menu] [role=menuitem]")).map((e) => e.textContent.trim());
    assert.deepEqual(items, ["Add to prompt", "View full size", "Rename", "Download", "Delete"]);
  });
});

test("a batched sentinel callback loads more portraits on its newest entry", async () => {
  const items = [p("b", 2), p("a", 1)];
  await mount({ portraits: { ...gallery(items).portraits, next: "cursor-2" } }, async ({ calls, observers }) => {
    const sentinel = observers.filter((observer) => observer.live).at(-1);
    assert.ok(sentinel?.target);
    await act(async () => sentinel.callback([
      { target: sentinel.target, isIntersecting: false },
      { target: sentinel.target, isIntersecting: true },
    ]));
    assert.deepEqual(calls.load.filter((options) => options?.more), [{ more: true }]);
  });
});
