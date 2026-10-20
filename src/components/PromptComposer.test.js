import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { createRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { PromptComposer, ReferenceStrip } from "./PromptComposer.jsx";
import { shouldCollapseComposer } from "./useComposerCollapse.js";
import { useStore } from "../lib/store";

test("composer renders attached references with the production store shape", () => {
  // tsx's JSX transform uses the classic runtime for this Next-owned source.
  const previousReact = globalThis.React;
  globalThis.React = React;
  const initial = useStore.getInitialState();
  const before = { ...initial };
  try {
    Object.assign(initial, {
      referenceImages: ["data:image/png;base64,aGVsbG8="],
      referenceKinds: ["image"],
      audioNotes: [{ name: "reference.mp3", ref: "/api/media/reference.mp3" }],
      prompt: "@audio1",
    });
    assert.equal(initial.referenceLabels, undefined);
    const html = renderToString(React.createElement(PromptComposer));
    assert.match(html, /data:image\/png;base64,aGVsbG8=/);
    assert.match(html, /@img1/);
    assert.match(html, /bg-mention\/20 text-mention">@audio1<\/span>/);
  } finally {
    Object.assign(initial, before);
    globalThis.React = previousReact;
  }
});

test("composer renders first and last frame staging card", () => {
  const previousReact = globalThis.React;
  globalThis.React = React;
  const initial = useStore.getInitialState();
  const before = { ...initial };
  try {
    Object.assign(initial, {
      mode: "video",
      model: "Seedance 2.5",
      firstFrame: "data:image/png;base64,Zmlyc3Q=",
      lastFrame: "data:image/png;base64,bGFzdA==",
    });
    const html = renderToString(React.createElement(PromptComposer));
    assert.match(html, /First Frame/);
    assert.match(html, /Last Frame/);
    assert.match(html, /Zmlyc3Q=/);
    assert.match(html, /bGFzdA==/);
  } finally {
    Object.assign(initial, before);
    globalThis.React = previousReact;
  }
});

test("composer renders empty staging slots when firstFrameMode is toggled on", () => {
  const previousReact = globalThis.React;
  globalThis.React = React;
  const initial = useStore.getInitialState();
  const before = { ...initial };
  try {
    Object.assign(initial, {
      mode: "video",
      model: "Seedance 2.5",
      firstFrameMode: true,
      firstFrame: null,
      lastFrame: null,
    });
    const html = renderToString(React.createElement(PromptComposer));
    assert.match(html, /Add First Frame/);
    assert.match(html, /\+ Last Frame \(optional\)/);
  } finally {
    Object.assign(initial, before);
    globalThis.React = previousReact;
  }
});

test("composer renders attached video references with @vid chips and motion transfer tooltip", () => {
  const previousReact = globalThis.React;
  globalThis.React = React;
  const initial = useStore.getInitialState();
  const before = { ...initial };
  try {
    Object.assign(initial, {
      mode: "video",
      model: "Seedance 2.5",
      referenceVideos: ["/api/media/dance-motion.mp4"],
      videoNotes: [{ name: "dance-motion.mp4", ref: "/api/media/dance-motion.mp4" }],
      prompt: "samurai dancing according to @vid1",
    });
    const html = renderToString(React.createElement(PromptComposer));
    assert.match(html, /@vid1/);
    assert.match(html, /dance-motion\.mp4/);
    assert.match(html, /motion or camera reference/);
  } finally {
    Object.assign(initial, before);
    globalThis.React = previousReact;
  }
});

test("ReferenceStrip renders single inline strip in order images, divider, videos, divider, audio", () => {
  const previousReact = globalThis.React;
  globalThis.React = React;
  try {
    const storeState = {
      referenceIds: ["id-a", "id-b"],
      referenceImages: ["/img-a.png", "/img-b.png"],
      referenceKinds: ["image", "image"],
      referenceVideos: ["/vid-1.mp4"],
      videoNotes: [{ name: "clip-1.mp4", ref: "/vid-1.mp4" }],
      audioNotes: [{ name: "voice-1.wav", ref: "/voice-1.wav", duration: 4.2 }],
      portraits: { items: [] },
    };
    const html = renderToString(React.createElement(ReferenceStrip, { store: storeState, insertTag() {} }));
    const imgIdx = html.indexOf('data-reference-media="image"');
    const div1Idx = html.indexOf('data-divider-between="image-video"');
    const vidIdx = html.indexOf('data-reference-media="video"');
    const div2Idx = html.indexOf('data-divider-between="video-audio"');
    const audIdx = html.indexOf('data-reference-media="audio"');
    assert.ok(imgIdx > -1, "image group rendered");
    assert.ok(div1Idx > imgIdx, "image-video divider follows images");
    assert.ok(vidIdx > div1Idx, "videos follow image-video divider");
    assert.ok(div2Idx > vidIdx, "video-audio divider follows videos");
    assert.ok(audIdx > div2Idx, "audio follows video-audio divider");
  } finally {
    globalThis.React = previousReact;
  }
});

test("clicking a reference opens the preview lightbox while dragging or clicking arrows does not", async () => {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost" });
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
  dom.window.requestAnimationFrame = globalThis.requestAnimationFrame;
  dom.window.cancelAnimationFrame = globalThis.cancelAnimationFrame;
  dom.window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {} });
  dom.window.HTMLElement.prototype.scrollIntoView = function () {};
  dom.window.HTMLElement.prototype.attachEvent = function () {};
  dom.window.HTMLElement.prototype.detachEvent = function () {};
  const reordered = [];
  const storeState = {
    referenceIds: ["ref-1", "ref-2"],
    referenceImages: ["/img-1.png", "/img-2.png"],
    referenceKinds: ["image", "image"],
    referenceVideos: ["/vid-1.mp4"],
    videoNotes: [{ name: "motion.mp4", ref: "/vid-1.mp4" }],
    audioNotes: [],
    portraits: { items: [] },
    reorderReferencesByIds: (ids) => reordered.push(ids),
    undoReferenceReorder() {},
    removeReference() {},
  };
  const root = createRoot(document.querySelector("#root"));
  try {
    await act(async () => {
      root.render(React.createElement(ReferenceStrip, { store: storeState, insertTag() {} }));
    });
    const strip = document.querySelector('[data-testid="reference-strip"]');
    const previewBtn1 = document.querySelector('button[aria-label="Preview reference 1"]');
    const moveRightBtn1 = document.querySelector('button[aria-label="Move reference 1 right"]');

    // Clicking the arrow button reorders and does NOT open the preview dialog
    await act(async () => {
      moveRightBtn1.click();
    });
    assert.deepEqual(reordered.at(-1), ["ref-2", "ref-1"]);
    assert.equal(document.querySelector('[role="dialog"]'), null, "arrow click does not open preview");

    // Dragging the thumbnail (>5px) reorders and does NOT open the preview dialog
    await act(async () => {
      previewBtn1.dispatchEvent(new dom.window.MouseEvent("pointerdown", { button: 0, clientX: 50, clientY: 20, bubbles: true }));
      strip.dispatchEvent(new dom.window.MouseEvent("pointermove", { clientX: 180, clientY: 20, bubbles: true }));
      strip.dispatchEvent(new dom.window.MouseEvent("pointerup", { bubbles: true }));
      previewBtn1.click();
    });
    assert.equal(document.querySelector('[role="dialog"]'), null, "drag gesture does not open preview");

    // Stationary click on reference opens the preview lightbox
    await act(async () => {
      previewBtn1.click();
    });
    const dialog = document.querySelector('[role="dialog"]');
    assert.ok(dialog, "stationary click opens preview lightbox");
    assert.equal(dialog.getAttribute("aria-label"), "Reference Preview");

    // Escape closes the preview lightbox
    await act(async () => {
      document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    assert.equal(document.querySelector('[role="dialog"]'), null, "Escape closes preview lightbox");
  } finally {
    await act(async () => root.unmount());
    await new Promise((resolve) => setTimeout(resolve, 10));
    Object.assign(globalThis, previous);
    dom.window.close();
  }
});

test("touch on a reference thumbnail leaves swipes to native scrolling, previews on tap and reorders only after a long press", async () => {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost" });
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
  dom.window.requestAnimationFrame = globalThis.requestAnimationFrame;
  dom.window.cancelAnimationFrame = globalThis.cancelAnimationFrame;
  dom.window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {} });
  dom.window.HTMLElement.prototype.scrollIntoView = function () {};
  const touch = (type, clientX, clientY = 20) => {
    const event = new dom.window.MouseEvent(type, { button: 0, clientX, clientY, bubbles: true, cancelable: true });
    Object.defineProperty(event, "pointerType", { value: "touch" });
    Object.defineProperty(event, "pointerId", { value: 7 });
    return event;
  };
  const touchMove = () => new dom.window.Event("touchmove", { bubbles: true, cancelable: true });
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const reordered = [];
  const storeState = {
    referenceIds: ["ref-1", "ref-2", "ref-3"],
    referenceImages: ["/img-1.png", "/img-2.png", "/img-3.png"],
    referenceKinds: ["image", "image", "image"],
    referenceVideos: [],
    audioNotes: [],
    portraits: { items: [] },
    reorderReferencesByIds: (ids) => reordered.push(ids),
    undoReferenceReorder() {},
    removeReference() {},
  };
  const root = createRoot(document.querySelector("#root"));
  try {
    await act(async () => root.render(React.createElement(ReferenceStrip, { store: storeState, insertTag() {} })));
    const strip = document.querySelector('[data-testid="reference-strip"]');
    const thumb = document.querySelector('button[aria-label="Preview reference 1"]');
    let captures = 0;
    strip.setPointerCapture = () => { captures += 1; };

    // A swipe is left to the browser: pointerdown is not prevented, nothing is captured, and the
    // pan's pointercancel neither reorders nor previews.
    const down = touch("pointerdown", 50);
    await act(async () => {
      thumb.dispatchEvent(down);
      thumb.dispatchEvent(touch("pointermove", 90));
      const move = touchMove();
      strip.dispatchEvent(move);
      assert.equal(move.defaultPrevented, false, "a swipe's touchmove can scroll the strip");
      thumb.dispatchEvent(touch("pointercancel", 90));
      await wait(400);
    });
    assert.equal(down.defaultPrevented, false, "touch pointerdown leaves native panning available");
    assert.equal(captures, 0);
    assert.equal(strip.getAttribute("data-reference-strip-dragging"), "false");
    assert.deepEqual(reordered, []);
    assert.equal(document.querySelector('[role="dialog"]'), null);

    // A touch that drifts past the slop without a pan does not preview or reorder either.
    await act(async () => {
      thumb.dispatchEvent(touch("pointerdown", 50));
      thumb.dispatchEvent(touch("pointermove", 50, 40));
      await wait(400);
      thumb.dispatchEvent(touch("pointerup", 50, 40));
      thumb.click();
    });
    assert.deepEqual(reordered, []);
    assert.equal(document.querySelector('[role="dialog"]'), null);

    // A tap opens the preview.
    await act(async () => {
      thumb.dispatchEvent(touch("pointerdown", 50));
      thumb.dispatchEvent(touch("pointerup", 50));
      thumb.click();
    });
    assert.ok(document.querySelector('[role="dialog"]'), "tap opens preview");
    await act(async () => document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    assert.equal(document.querySelector('[role="dialog"]'), null);

    // A long press starts the drag, holds the strip still and reorders on release.
    await act(async () => {
      thumb.dispatchEvent(touch("pointerdown", 50));
      await wait(400);
    });
    assert.equal(strip.getAttribute("data-reference-strip-dragging"), "true", "long press starts the reorder drag");
    assert.equal(captures, 1);
    await act(async () => {
      const move = touchMove();
      strip.dispatchEvent(move);
      assert.equal(move.defaultPrevented, true, "a long-press drag keeps the strip from scrolling");
      strip.dispatchEvent(touch("pointermove", 180));
      await wait(20);
      strip.dispatchEvent(touch("pointerup", 180));
    });
    assert.deepEqual(reordered.at(-1), ["ref-2", "ref-3", "ref-1"]);
    assert.equal(document.querySelector('[role="dialog"]'), null, "a long-press drag does not open preview");
  } finally {
    await act(async () => root.unmount());
    await new Promise((resolve) => setTimeout(resolve, 10));
    Object.assign(globalThis, previous);
    dom.window.close();
  }
});

test("composer collapse helper and interactive shell collapse on send and blur/leave, expand on focus, and stay open while overlays are active", async () => {
  assert.equal(shouldCollapseComposer({ hasFocus: false, hasPointer: false }), true);
  assert.equal(shouldCollapseComposer({ hasFocus: true, hasPointer: false }), false);
  assert.equal(shouldCollapseComposer({ hasFocus: false, hasPointer: true }), false);
  assert.equal(shouldCollapseComposer({ hasFocus: false, hasPointer: false, menuOpen: true }), false);
  assert.equal(shouldCollapseComposer({ hasFocus: false, hasPointer: false, dropdownOpen: true }), false);
  assert.equal(shouldCollapseComposer({ hasFocus: false, hasPointer: false, filePickerOpen: true }), false);
  assert.equal(shouldCollapseComposer({ hasFocus: false, hasPointer: false, dragging: true }), false);
  assert.equal(shouldCollapseComposer({ hasFocus: false, hasPointer: false, previewOpen: true }), false);

  const dom = new JSDOM("<button id='outside'>Outside</button><div id='root'></div>", { url: "http://localhost" });
  const keys = ["window", "document", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "ResizeObserver", "MutationObserver", "requestAnimationFrame", "cancelAnimationFrame", "React", "IS_REACT_ACT_ENVIRONMENT"];
  const previous = Object.fromEntries(keys.map((key) => [key, globalThis[key]]));
  const rafTimers = new Set();
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
    ResizeObserver: class { observe() {} disconnect() {} },
    MutationObserver: class { observe() {} disconnect() {} },
    React,
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (fn) => {
      const id = setTimeout(() => {
        rafTimers.delete(id);
        fn(Date.now());
      }, 0);
      rafTimers.add(id);
      return id;
    },
    cancelAnimationFrame: (id) => {
      rafTimers.delete(id);
      clearTimeout(id);
    },
  });
  dom.window.requestAnimationFrame = globalThis.requestAnimationFrame;
  dom.window.cancelAnimationFrame = globalThis.cancelAnimationFrame;
  dom.window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {} });
  dom.window.HTMLElement.prototype.scrollIntoView = function () {};
  dom.window.HTMLElement.prototype.attachEvent = function () {};
  dom.window.HTMLElement.prototype.detachEvent = function () {};
  const initial = useStore.getInitialState();
  const before = { ...initial };
  const root = createRoot(document.querySelector("#root"));
  try {
    let generateCalls = 0;
    useStore.setState({
      prompt: "Draft prompt with @img1 preserved",
      referenceImages: ["/preserved.png"],
      referenceIds: ["ref-preserved"],
      referenceKinds: ["image"],
      generating: false,
      generate: async () => {
        generateCalls += 1;
        return [{ id: "gen-1" }];
      },
    });
    await act(async () => {
      root.render(React.createElement(PromptComposer));
    });
    const composer = document.querySelector('[data-testid="prompt-composer"]');
    const textarea = composer.querySelector("textarea");
    const generateBtn = composer.querySelector('button[aria-label="Generate"]');

    // Starts collapsed while keeping prompt input, send button, and references
    assert.equal(composer.getAttribute("data-composer-collapsed"), "true");
    assert.equal(textarea.value, "Draft prompt with @img1 preserved");
    assert.ok(generateBtn, "send button visible when collapsed");
    assert.equal(composer.querySelectorAll("[data-reference-id]").length, 1, "references preserved when collapsed");

    // Expands on focus
    await act(async () => {
      textarea.focus();
    });
    assert.equal(composer.getAttribute("data-composer-collapsed"), "false");

    // Does not collapse when focus leaves if pointer is still inside
    await act(async () => {
      composer.dispatchEvent(new dom.window.MouseEvent("mouseenter"));
      document.querySelector("#outside").focus();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    assert.equal(composer.getAttribute("data-composer-collapsed"), "false", "stays expanded while pointer is inside");

    // Collapses once pointer also leaves
    await act(async () => {
      composer.dispatchEvent(new dom.window.MouseEvent("mouseleave"));
    });
    assert.equal(composer.getAttribute("data-composer-collapsed"), "true", "collapses when both focus and pointer leave");
    assert.equal(textarea.value, "Draft prompt with @img1 preserved", "draft text preserved on collapse");

    // Expands on focus again, stays expanded while preview lightbox is open, then collapses after a successful send
    await act(async () => {
      textarea.focus();
    });
    assert.equal(composer.getAttribute("data-composer-collapsed"), "false");
    const mockDialog = document.createElement("div");
    mockDialog.setAttribute("role", "dialog");
    mockDialog.setAttribute("aria-modal", "true");
    document.body.appendChild(mockDialog);
    await act(async () => {
      document.querySelector("#outside").focus();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    assert.equal(composer.getAttribute("data-composer-collapsed"), "false", "does not collapse while preview lightbox is open");
    mockDialog.remove();
    await act(async () => {
      textarea.focus();
    });
    assert.equal(composer.getAttribute("data-composer-collapsed"), "false");
    await act(async () => {
      generateBtn.click();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    assert.equal(generateCalls, 1);
    assert.equal(composer.getAttribute("data-composer-collapsed"), "true", "collapses after successful send");
    assert.equal(composer.querySelectorAll("[data-reference-id]").length, 1, "references preserved after send collapse");
  } finally {
    await act(async () => root.unmount());
    for (const id of rafTimers) clearTimeout(id);
    rafTimers.clear();
    useStore.setState(before, true);
    Object.assign(globalThis, previous);
    dom.window.close();
  }
});

