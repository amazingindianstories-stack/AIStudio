import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { createRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import {
  AssetLightbox,
  clampLightboxZoom,
  stepLightboxZoom,
  computeWheelZoom,
} from "./AssetLightbox.jsx";

test("AssetLightbox renders asset name, @slug pill, kind label, and uncropped image", () => {
  const previousReact = globalThis.React;
  globalThis.React = React;
  try {
    const mockAsset = {
      id: "asset-123",
      name: "Sati Warrior Sheet",
      slug: "sati-warrior",
      kind: "character",
      images: ["https://example.com/sati-turnaround.png"],
      description: "Full character turnaround sheet showing front, side, and back views",
    };

    const html = renderToString(
      React.createElement(AssetLightbox, {
        asset: mockAsset,
        assets: [mockAsset],
        onClose() {},
        onSelectAsset() {},
        onAttach() {},
        onEdit() {},
        onDelete() {},
      })
    );

    // Verifies title and slug
    assert.match(html, /Sati Warrior Sheet/);
    assert.match(html, /@sati-warrior/);
    assert.match(html, /Character/);

    // Verifies uncropped image with object-contain
    assert.match(html, /object-contain/);
    assert.match(html, /https:\/\/example\.com\/sati-turnaround\.png/);

    // Verifies readable contrast on primary action button
    assert.match(html, /bg-white/);
    assert.match(html, /text-zinc-950/);
    assert.match(html, /Attach to Composer/);

    // Verifies description hint
    assert.match(html, /Full character turnaround sheet/);
  } finally {
    globalThis.React = previousReact;
  }
});

test("AssetLightbox returns null when no asset is provided", () => {
  const previousReact = globalThis.React;
  globalThis.React = React;
  try {
    const html = renderToString(
      React.createElement(AssetLightbox, {
        asset: null,
        assets: [],
        onClose() {},
      })
    );
    assert.equal(html, "");
  } finally {
    globalThis.React = previousReact;
  }
});

test("AssetLightbox supports wheel, pinch, ctrl/cmd+wheel, double-click, buttons, keyboard +/-/0, pan by drag, Escape close, and focus restoration", async () => {
  assert.equal(clampLightboxZoom(10), 5);
  assert.equal(clampLightboxZoom(0.1), 0.5);
  assert.equal(stepLightboxZoom(1, 1), 1.25);
  assert.equal(stepLightboxZoom(1, -1), 0.75);
  assert.ok(computeWheelZoom(1, -100, false) > 1);
  assert.ok(computeWheelZoom(1, 100, false) < 1);
  assert.ok(computeWheelZoom(1, -50, true) > 1);

  const dom = new JSDOM("<button id='ref-trigger'>Preview ref</button><div id='root'></div>", { url: "http://localhost" });
  const keys = ["window", "document", "HTMLElement", "requestAnimationFrame", "cancelAnimationFrame", "React", "IS_REACT_ACT_ENVIRONMENT"];
  const previous = Object.fromEntries(keys.map((key) => [key, globalThis[key]]));
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    React,
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    cancelAnimationFrame: clearTimeout,
  });
  const triggerEl = document.querySelector("#ref-trigger");
  triggerEl.focus();
  const root = createRoot(document.querySelector("#root"));
  let closed = false;
  const asset = {
    id: "img:1",
    name: "Reference 1",
    tag: "@img1",
    slug: "img1",
    kind: "image",
    mediaType: "image",
    isComposerReference: true,
    image: "/ref1.png",
  };
  try {
    await act(async () => {
      root.render(
        React.createElement(AssetLightbox, {
          asset,
          assets: [asset],
          returnFocusEl: triggerEl,
          dialogLabel: "Reference Preview",
          onClose: () => {
            closed = true;
          },
        })
      );
    });
    const stage = document.querySelector('[data-testid="lightbox-stage"]');
    assert.equal(stage.getAttribute("data-zoom"), "1");

    // 1. Wheel zoom in/out
    await act(async () => {
      stage.dispatchEvent(new dom.window.WheelEvent("wheel", { deltaY: -120, bubbles: true, cancelable: true }));
    });
    assert.equal(stage.getAttribute("data-zoom"), "1.25");
    await act(async () => {
      stage.dispatchEvent(new dom.window.WheelEvent("wheel", { deltaY: 120, bubbles: true, cancelable: true }));
    });
    assert.equal(stage.getAttribute("data-zoom"), "1");

    // 2. Trackpad pinch & Ctrl/Cmd + wheel
    await act(async () => {
      stage.dispatchEvent(new dom.window.WheelEvent("wheel", { deltaY: -50, ctrlKey: true, bubbles: true, cancelable: true }));
    });
    assert.equal(stage.getAttribute("data-zoom"), "1.5");
    await act(async () => {
      stage.dispatchEvent(new dom.window.WheelEvent("wheel", { deltaY: 25, metaKey: true, bubbles: true, cancelable: true }));
    });
    assert.equal(stage.getAttribute("data-zoom"), "1.25");

    // 3. Buttons: Zoom in, Zoom out, Reset zoom
    await act(async () => {
      document.querySelector('[data-testid="lightbox-zoom-in"]').click();
    });
    assert.equal(stage.getAttribute("data-zoom"), "1.5");
    await act(async () => {
      document.querySelector('[data-testid="lightbox-zoom-out"]').click();
    });
    assert.equal(stage.getAttribute("data-zoom"), "1.25");
    await act(async () => {
      document.querySelector('[data-testid="lightbox-zoom-reset"]').click();
    });
    assert.equal(stage.getAttribute("data-zoom"), "1");

    // 4. Double-click zoom toggle
    await act(async () => {
      stage.dispatchEvent(new dom.window.MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    });
    assert.equal(stage.getAttribute("data-zoom"), "2");

    // 5. Pan by drag when zoomed
    await act(async () => {
      stage.dispatchEvent(new dom.window.MouseEvent("pointerdown", { button: 0, clientX: 100, clientY: 100, bubbles: true }));
      stage.dispatchEvent(new dom.window.MouseEvent("pointermove", { clientX: 145, clientY: 130, bubbles: true }));
      stage.dispatchEvent(new dom.window.MouseEvent("pointerup", { bubbles: true }));
    });
    assert.equal(stage.getAttribute("data-pan-x"), "45");
    assert.equal(stage.getAttribute("data-pan-y"), "30");

    // 6. Keyboard +, -, 0
    await act(async () => {
      document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "+", bubbles: true }));
    });
    assert.equal(stage.getAttribute("data-zoom"), "2.25");
    await act(async () => {
      document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "-", bubbles: true }));
    });
    assert.equal(stage.getAttribute("data-zoom"), "2");
    await act(async () => {
      document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "0", bubbles: true }));
    });
    assert.equal(stage.getAttribute("data-zoom"), "1");
    assert.equal(stage.getAttribute("data-pan-x"), "0");
    assert.equal(stage.getAttribute("data-pan-y"), "0");

    // 7. Escape closes and unmount restores focus to reference trigger
    await act(async () => {
      document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    assert.equal(closed, true);
    await act(async () => {
      root.unmount();
    });
    assert.equal(document.activeElement, triggerEl, "focus returns to the originating reference");
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 10));
    Object.assign(globalThis, previous);
    dom.window.close();
  }
});
