import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { createRoot } from "react-dom/client";
import { LibraryFilters, LibraryFilterChips, LibraryNoMatches, LibraryResultsAnnouncer } from "./LibraryFilters";
import { useStore } from "../lib/store";
import { emptyLibraryFilters } from "../lib/library-filters";

test("filter edits stage until Show results; Cancel discards and chip clear preserves search and source", async () => {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost" });
  const names = ["window", "document", "HTMLElement", "React", "IS_REACT_ACT_ENVIRONMENT", "fetch", "ResizeObserver"];
  const before = Object.fromEntries(names.map(name => [name, globalThis[name]])), original = useStore.getState();
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    React, IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: class { observe() {} disconnect() {} },
    fetch: async () => new Response(JSON.stringify({ options: { types: ["image", "video"], models: [], aspects: [], resolutions: [], creators: [] } })) });
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  dom.window.HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  useStore.setState({ libraryFilters: emptyLibraryFilters(), filterKind: "all", rightTab: "folder", activeFolderId: "source", search: "mountain" });
  const root = createRoot(document.querySelector("#root"));
  const button = label => [...document.querySelectorAll("button")].find(node => node.textContent === label);
  const option = label => [...document.querySelectorAll(".library-filter-option")].find(node => node.textContent === label).querySelector("input");
  try {
    await act(async () => root.render(React.createElement(React.Fragment, null, React.createElement(LibraryFilters), React.createElement(LibraryFilterChips))));
    await act(async () => button("Filters").click());
    await act(async () => option("Videos").click());
    assert.deepEqual(useStore.getState().libraryFilters.types, []);
    await act(async () => button("Cancel").click());
    await act(async () => button("Filters").click());
    assert.equal(option("Videos").checked, false);
    await act(async () => option("Videos").click());
    await act(async () => button("Show results").click());
    assert.deepEqual(useStore.getState().libraryFilters.types, ["video"]);
    assert.match(document.querySelector('[aria-label="Active library filters"]').textContent, /Type: Videos/);
    await act(async () => button("Clear filters").click());
    assert.deepEqual(useStore.getState().libraryFilters, emptyLibraryFilters());
    assert.equal(useStore.getState().search, "mountain");
    assert.equal(useStore.getState().activeFolderId, "source");
  } finally {
    await act(async () => root.unmount()); useStore.setState(original, true);
    Object.assign(globalThis, before); dom.window.close();
  }
});

test("options read as settings, ratios get outlines, chips use day labels and the empty state names a video conflict", async () => {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost" });
  const names = ["window", "document", "HTMLElement", "React", "IS_REACT_ACT_ENVIRONMENT", "fetch", "ResizeObserver"];
  const before = Object.fromEntries(names.map(name => [name, globalThis[name]])), original = useStore.getState();
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    React, IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: class { observe() {} disconnect() {} },
    fetch: async () => new Response(JSON.stringify({ options: { types: ["image", "video"], models: [], aspects: ["3:2"], resolutions: ["image:2k", "image:unknown", "video:1080p"], creators: [] } })) });
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  dom.window.HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  const thisYear = new Date().getFullYear();
  useStore.setState({ libraryFilters: { ...emptyLibraryFilters(), date: "custom", from: `${thisYear}-01-02`, through: `${thisYear}-01-05` },
    filterKind: "all", rightTab: "folder", activeFolderId: "source", search: "" });
  const root = createRoot(document.querySelector("#root"));
  const button = label => [...document.querySelectorAll("button")].find(node => node.textContent.startsWith(label));
  const labels = () => [...document.querySelectorAll(".library-filter-option")].map(node => node.textContent);
  try {
    await act(async () => root.render(React.createElement(React.Fragment, null, React.createElement(LibraryFilters), React.createElement(LibraryFilterChips), React.createElement(LibraryNoMatches))));
    assert.match(document.querySelector('[aria-label="Active library filters"]').textContent, /Date created: 2 Jan to 5 Jan/);
    await act(async () => button("Filters").click());
    await act(async () => button("Resolution").click());
    assert.deepEqual(labels(), ["2K", "Not recorded", "1080p"]);
    await act(async () => button("Aspect ratio").click());
    assert.ok(labels().includes("3:2"));
    assert.equal(document.querySelectorAll(".library-filter-ratio i").length, labels().length);
    // This source records every video field, so Not recorded is not offered.
    await act(async () => button("Video").click());
    assert.deepEqual(labels(), ["Up to 5s", "6-10s", "Over 10s", "Draft", "Final"]);
    await act(async () => button("Cancel").click());
    await act(async () => useStore.getState().setLibraryFilters({ ...emptyLibraryFilters(), types: ["image"], stages: ["draft"] }));
    assert.match(document.body.textContent, /only match videos/);
  } finally {
    await act(async () => root.unmount()); useStore.setState(original, true);
    Object.assign(globalThis, before); dom.window.close();
  }
});

test("Not recorded follows the source catalog, and applied filters are announced without calling a page a total", async () => {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost" });
  const names = ["window", "document", "HTMLElement", "React", "IS_REACT_ACT_ENVIRONMENT", "fetch", "ResizeObserver"];
  const before = Object.fromEntries(names.map(name => [name, globalThis[name]])), original = useStore.getState();
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    React, IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: class { observe() {} disconnect() {} },
    fetch: async () => new Response(JSON.stringify({ options: { types: ["video"], models: [], aspects: [], resolutions: [], creators: [], unrecorded: ["stage"] } })) });
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  dom.window.HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  useStore.setState({ libraryFilters: emptyLibraryFilters(), filterKind: "all", rightTab: "folder", activeFolderId: "source", search: "",
    loading: false, items: [{ id: "a" }, { id: "b" }], hasMoreHistory: false });
  const root = createRoot(document.querySelector("#root"));
  const button = label => [...document.querySelectorAll("button")].find(node => node.textContent.startsWith(label));
  const labels = () => [...document.querySelectorAll(".library-filter-option")].map(node => node.textContent);
  const announced = () => document.querySelector('[role="status"]').textContent;
  const apply = async (patch, filters = { ...emptyLibraryFilters(), types: ["video"] }) => act(async () => useStore.setState({ libraryFilters: filters, ...patch }));
  try {
    await act(async () => root.render(React.createElement(React.Fragment, null, React.createElement(LibraryFilters), React.createElement(LibraryResultsAnnouncer))));
    await act(async () => button("Filters").click());
    await act(async () => button("Video").click());
    assert.deepEqual(labels(), ["Up to 5s", "6-10s", "Over 10s", "Draft", "Final", "Not recorded"]);
    await act(async () => button("More").click());
    assert.deepEqual(labels(), ["Ready", "Creating", "Failed", "High", "Standard"]);
    await act(async () => button("Cancel").click());
    assert.equal(announced(), "");
    await apply({ loading: true });
    assert.equal(announced(), "");
    await act(async () => useStore.setState({ loading: false, items: [{ id: "a" }], hasMoreHistory: false }));
    assert.equal(announced(), "Showing 1 result.");
    await apply({ items: [{ id: "a" }, { id: "b" }], hasMoreHistory: true });
    assert.equal(announced(), "Showing matching work. More loads as you scroll.");
    // Navigation restoring another source's query is not an applied change.
    await apply({ activeFolderId: "other", items: [] }, emptyLibraryFilters());
    assert.equal(announced(), "Showing matching work. More loads as you scroll.");
    await apply({ items: [], hasMoreHistory: false });
    assert.equal(announced(), "No matching work.");
  } finally {
    await act(async () => root.unmount()); useStore.setState(original, true);
    Object.assign(globalThis, before); dom.window.close();
  }
});
