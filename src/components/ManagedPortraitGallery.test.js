import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { createRoot } from "react-dom/client";
import { useStore } from "../lib/store";
import { useTextRequest, settleTextRequest } from "../lib/ask-text";
import { PortraitGallery } from "./PortraitGallery.jsx";
import { portraitLifetime, relativeDuration } from "./ManagedPortraitGallery.jsx";

test("lifetime copy explains in-use protection and expiry", () => {
  const now = 1_000_000;
  assert.equal(portraitLifetime({ inUse: 2, label: "Ready" }, now), "In use by 2 generations — kept until it finishes");
  assert.equal(portraitLifetime({ inUse: 0, label: "Ready", expiresAt: now + 3 * 3600000 + 12 * 60000 }, now), "Removed in 3h 12m if unused");
  assert.equal(portraitLifetime({ inUse: 0, label: "Ready", expiresAt: now - 1 }, now), "Being removed (unused)");
  assert.equal(relativeDuration(30 * 1000), "less than a minute");
});

test("managed gallery replaces manual uploads: statuses, in-use protection and delete", async () => {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost" });
  const keys = ["window", "document", "HTMLElement", "requestAnimationFrame", "cancelAnimationFrame", "React", "IS_REACT_ACT_ENVIRONMENT"];
  const previous = Object.fromEntries(keys.map((key) => [key, globalThis[key]]));
  const previousStore = useStore.getState();
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, React,
    IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: (fn) => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout });
  const deleted = [];
  const assets = [
    { id: "a1", label: "Ready", status: "ACTIVE", inUse: 1, imageUrl: "/api/media/uploads/image-reference/x", expiresAt: Date.now() + 3600000, createdBy: "Pankaj" },
    { id: "a2", label: "Ready", status: "ACTIVE", inUse: 0, imageUrl: "/api/media/uploads/image-reference/y", expiresAt: Date.now() + 7200000 },
  ];
  useStore.setState({ portraitGalleryOpen: true, managedPortraits: { enabled: true, assets, usage: { live: 2, capacity: 90, inUse: 1, ttlHours: 4 }, loading: false, error: null },
    loadManagedPortraits: async () => {}, deleteManagedPortrait: async (id) => { deleted.push(id); return { ok: true }; } });
  useTextRequest.setState({ request: null, hostMounted: true });
  const root = createRoot(document.querySelector("#root"));
  try {
    await act(async () => root.render(React.createElement(PortraitGallery)));
    assert.ok(document.querySelector("[aria-label='Portraits']"), "managed gallery is shown");
    assert.equal(document.querySelector("input[type=file]"), null, "no manual upload control");
    assert.match(document.querySelector("[data-portrait-usage]").textContent, /2 of 90 stored · 1 in use/);
    const cards = document.querySelectorAll("[data-managed-portrait]");
    assert.equal(cards.length, 2);
    const removeButton = (card) => card.querySelector("button[aria-label='Remove portrait']");
    assert.equal(removeButton(cards[0]).disabled, true, "a portrait in use cannot be removed");
    assert.match(cards[0].textContent, /kept until it finishes/);
    assert.equal(removeButton(cards[1]).disabled, false);
    await act(async () => removeButton(cards[1]).click());
    assert.equal(useTextRequest.getState().request.kind, "confirm");
    await act(async () => settleTextRequest(true));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    assert.deepEqual(deleted, ["a2"]);
  } finally {
    await act(async () => root.unmount());
    useStore.setState(previousStore, true);
    useTextRequest.setState({ request: null, hostMounted: false });
    for (const key of keys) globalThis[key] = previous[key];
  }
});
