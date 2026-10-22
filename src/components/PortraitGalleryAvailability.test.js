import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { createRoot } from "react-dom/client";
import { PromptComposer } from "./PromptComposer.jsx";
import { PortraitGallery } from "./PortraitGallery.jsx";
import { useStore } from "../lib/store";

for (const enabled of [false, true]) {
  test(`signed-in composer only offers Portrait Gallery when managed portraits are on (${enabled})`, async () => {
    const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost" });
    const keys = ["window", "document", "HTMLElement", "Element", "Node", "React", "IS_REACT_ACT_ENVIRONMENT", "requestAnimationFrame", "cancelAnimationFrame", "ResizeObserver", "MutationObserver", "fetch"];
    const before = Object.fromEntries(keys.map((key) => [key, globalThis[key]]));
    const previous = useStore.getState();
    const requests = [];
    Object.assign(globalThis, {
      window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
      Element: dom.window.Element, Node: dom.window.Node, MutationObserver: dom.window.MutationObserver, React, IS_REACT_ACT_ENVIRONMENT: true,
      requestAnimationFrame: (fn) => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout,
      ResizeObserver: class { observe() {} disconnect() {} },
      fetch: async (url) => {
        requests.push(String(url));
        const body = String(url) === "/api/auth/me"
          ? { user: { id: "artist", role: "user" } }
          : { enabled, portraits: [], next: null };
        return new Response(JSON.stringify(body));
      },
    });
    window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    window.HTMLElement.prototype.scrollIntoView = () => {};
    useStore.setState({
      ...useStore.getInitialState(),
      portraits: { ...useStore.getInitialState().portraits },
      referenceImages: ["/api/media/uploads/portrait/existing.png"],
      referenceKinds: ["portrait"], referenceIds: ["existing"],
    }, true);
    const root = createRoot(document.querySelector("#root"));
    const menuItem = (text) => [...document.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent.includes(text));
    try {
      await act(async () => root.render(React.createElement(React.Fragment, null,
        React.createElement(PromptComposer), React.createElement(PortraitGallery))));
      const trigger = [...document.querySelectorAll('button[aria-haspopup="menu"]')].find((item) => item.textContent.includes("material"));
      assert.ok(trigger, "attachment menu is reachable");
      await act(async () => trigger.click());
      assert.equal(Boolean(menuItem("Portrait Gallery")), false, "unknown availability stays hidden");
      await act(async () => useStore.getState().loadMe());
      assert.ok(requests.some((url) => url.startsWith("/api/portraits?")), "startup asks the authoritative portrait endpoint");
      assert.equal(useStore.getState().portraits.enabled, enabled);
      assert.equal(Boolean(menuItem("Portrait Gallery")), enabled);
      assert.ok(menuItem("Material library"), "manual material library remains available");
      assert.ok(menuItem("Local upload"), "manual upload remains available");
      assert.ok(document.querySelector('[data-reference-source="portrait"]'), "existing portrait references remain visible");
      if (enabled) {
        await act(async () => menuItem("Portrait Gallery").click());
        assert.ok(document.querySelector('[role="dialog"][aria-label="Portrait Gallery"]'));
        assert.equal(document.body.textContent.includes("Portraits are unavailable right now"), false);
        await act(async () => document.querySelector('button[aria-label="Close Portrait Gallery"]').click());
      } else {
        await act(async () => menuItem("Material library").click());
        assert.equal(useStore.getState().assetLibraryOpen, true);
        assert.equal(useStore.getState().portraitGalleryOpen, false);
      }
    } finally {
      await act(async () => root.unmount());
      useStore.setState(previous, true);
      await new Promise((resolve) => setTimeout(resolve, 20));
      Object.assign(globalThis, before);
      dom.window.close();
    }
  });
}
