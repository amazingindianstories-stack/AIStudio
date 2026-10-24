import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { createRoot } from "react-dom/client";
import { LibraryFilters, LibraryFilterChips } from "./LibraryFilters";
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
