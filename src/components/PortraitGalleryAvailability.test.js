import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { createRoot } from "react-dom/client";
import { PromptComposer } from "./PromptComposer.jsx";
import { PortraitGallery } from "./PortraitGallery.jsx";
import { useStore } from "../lib/store";

async function withComposer(portraitResponse, run) {
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
      if (String(url) === "/api/auth/me") return new Response(JSON.stringify({ user: { id: "artist", role: "user" } }));
      return portraitResponse(requests.filter((item) => item.startsWith("/api/portraits?")).length);
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
  const trigger = () => [...document.querySelectorAll('button[aria-haspopup="menu"]')].find((item) => item.textContent.includes("material"));
  try {
    await act(async () => root.render(React.createElement(React.Fragment, null,
      React.createElement(PromptComposer), React.createElement(PortraitGallery))));
    assert.ok(trigger(), "attachment menu is reachable");
    await run({ requests, menuItem, trigger });
  } finally {
    await act(async () => root.unmount());
    useStore.setState(previous, true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    Object.assign(globalThis, before);
    dom.window.close();
  }
}

const portraitList = (enabled) => new Response(JSON.stringify({ enabled, portraits: [], next: null }));
const portraitRequests = (requests) => requests.filter((url) => url.startsWith("/api/portraits?")).length;

for (const enabled of [false, true]) {
  test(`signed-in composer only offers Portrait Gallery when managed portraits are on (${enabled})`, async () => {
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    await withComposer(async () => { await held; return portraitList(enabled); }, async ({ requests, menuItem, trigger }) => {
      await act(async () => trigger().click());
      assert.equal(Boolean(menuItem("Portrait Gallery")), false, "unknown availability stays hidden");
      release();
      await act(async () => useStore.getState().loadMe());
      assert.ok(portraitRequests(requests) > 0, "startup asks the authoritative portrait endpoint");
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
    });
  });
}

test("opening the attachment menu recovers Portrait Gallery after a failed startup check", async () => {
  const respond = (count) => (count === 1
    ? new Response(JSON.stringify({ error: "Bad gateway" }), { status: 502 })
    : portraitList(true));
  await withComposer(respond, async ({ requests, menuItem, trigger }) => {
    await act(async () => useStore.getState().loadMe());
    assert.equal(useStore.getState().portraits.enabled, null);
    assert.ok(useStore.getState().portraits.error, "the failed startup check is recorded");
    await act(async () => trigger().click());
    assert.equal(portraitRequests(requests), 2, "opening the menu asks again while availability is unknown");
    assert.equal(useStore.getState().portraits.enabled, true);
    assert.ok(menuItem("Portrait Gallery"), "the gallery entry returns once the switch is confirmed on");
    await act(async () => trigger().click());
    await act(async () => trigger().click());
    assert.equal(portraitRequests(requests), 2, "known availability is not fetched again on reopen");
  });
});
