import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { AssetLibrary } from "./AssetLibrary.jsx";
import { useStore } from "../lib/store";

test("material modal contains focus, returns to opener and respects child dialogs and editing Escape", async () => {
  const dom = new JSDOM("<button id='opener'>Materials</button><div id='root'></div>", { url: "http://localhost" });
  const keys = ["window", "document", "HTMLElement", "requestAnimationFrame", "cancelAnimationFrame", "React", "IS_REACT_ACT_ENVIRONMENT"];
  const previous = Object.fromEntries(keys.map((key) => [key, globalThis[key]]));
  const state = useStore.getState();
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, React, IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: (fn) => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout });
  dom.window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {} });
  dom.window.HTMLElement.prototype.getClientRects = function () { return this.hidden || this.classList.contains("hidden") ? [] : [{ width: 100, height: 20 }]; };
  dom.window.HTMLElement.prototype.attachEvent = function () {};
  dom.window.HTMLElement.prototype.detachEvent = function () {};
  const root = createRoot(document.querySelector("#root"));
  const keyboard = (key, shiftKey = false) => new dom.window.KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true });
  const opener = document.querySelector("#opener");
  opener.focus();
  try {
    useStore.setState({ assetLibraryOpen: true, editingAsset: null, assets: [], projects: [], loadAssets() {} });
    await act(async () => { root.render(React.createElement(AssetLibrary)); await new Promise((r) => setTimeout(r, 20)); });
    await act(async () => new Promise((r) => setTimeout(r, 20)));
    const dialog = document.querySelector('[aria-label="Material Library"]');
    const first = dialog.querySelector('button');
    assert.equal(document.activeElement, first);
    first.dispatchEvent(keyboard("Tab", true));
    const last = document.activeElement;
    assert.notEqual(first, last);
    last.dispatchEvent(keyboard("Tab"));
    assert.equal(document.activeElement, first);
    opener.focus();
    assert.equal(document.activeElement, first, "programmatic outside focus returns inside");
    const child = document.createElement("div");
    child.setAttribute("role", "alertdialog"); child.setAttribute("aria-modal", "true");
    child.innerHTML = "<button>Cancel</button>"; document.body.append(child);
    child.querySelector("button").focus();
    await act(async () => child.dispatchEvent(keyboard("Escape")));
    assert.equal(useStore.getState().assetLibraryOpen, true, "parent must not close child confirmation");
    assert.equal(document.activeElement, child.querySelector("button"));
    child.remove();
    await act(async () => useStore.setState({ editingAsset: "new" }));
    await act(async () => dialog.dispatchEvent(keyboard("Escape")));
    assert.equal(useStore.getState().editingAsset, null);
    assert.equal(useStore.getState().assetLibraryOpen, true);
    await act(async () => dialog.dispatchEvent(keyboard("Escape")));
    assert.equal(useStore.getState().assetLibraryOpen, false);
    assert.equal(document.activeElement, opener);
  } finally {
    await act(async () => root.unmount());
    useStore.setState(state, true);
    await new Promise((r) => setTimeout(r, 20));
    Object.assign(globalThis, previous);
    dom.window.close();
  }
});
