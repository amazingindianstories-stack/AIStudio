import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { createRoot } from "react-dom/client";
import { FeedBlock } from "./ConversationPanel.jsx";
import { useStore } from "../lib/store";
import { ReferenceStrip, stagedReferenceCount, referenceSubmissionWarning } from "./PromptComposer.jsx";
import { uploadContentType } from "../lib/client-reference-upload";
import { MentionTextarea, mapMentionSelection } from "./MentionTextarea.jsx";
import { resolveGenerationFolder, relativeGenerationTime } from "./MediaCard.jsx";

test("reference controls preserve duplicate occurrence IDs and support move, keyboard, position and undo", async () => {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost" });
  const keys = ["window", "document", "HTMLElement", "requestAnimationFrame", "cancelAnimationFrame", "React", "IS_REACT_ACT_ENVIRONMENT"];
  const previous = Object.fromEntries(keys.map((key) => [key, globalThis[key]]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, React, IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: (fn) => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout });
  dom.window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {} });
  dom.window.HTMLElement.prototype.scrollIntoView = function () {};
  dom.window.HTMLElement.prototype.attachEvent = function () {};
  dom.window.HTMLElement.prototype.detachEvent = function () {};
  const ordered = [], inserted = [];
  let undo = false;
  const s = { referenceIds: ["first", "second", "third"], referenceImages: ["/same.png", "/same.png", "/other.png"], referenceKinds: ["portrait", "portrait", "image"], referenceLabels: ["Same", "Same", "Other"], referenceTags: ["@sati", "", ""], portraitAssets: [], reorderReferencesByIds: (ids) => ordered.push(ids), undoReferenceReorder: () => { undo = true; }, removeReference() {} };
  const root = createRoot(document.querySelector("#root"));
  try {
    await act(async () => root.render(React.createElement(ReferenceStrip, { store: s, insertTag: (tag) => inserted.push(tag) })));
    assert.equal(document.querySelectorAll("[data-reference-id]").length, 3);
    assert.equal(document.querySelectorAll("[data-reference-grip]").length, 0, "handlebar grip is removed");
    const button = (name) => document.querySelector(`button[aria-label='${name}']`);
    const firstCard = document.querySelector('[data-reference-id="first"]');
    assert.equal(firstCard.getAttribute("data-arrows-visible"), "false", "side arrows are collapsed when not hovered or focused");
    await act(async () => firstCard.dispatchEvent(new dom.window.MouseEvent("mouseover", { bubbles: true })));
    assert.equal(firstCard.getAttribute("data-arrows-visible"), "true", "side arrows appear on hover");
    await act(async () => firstCard.dispatchEvent(new dom.window.MouseEvent("mouseout", { bubbles: true })));
    assert.equal(firstCard.getAttribute("data-arrows-visible"), "false");
    const scrollSurface = document.querySelector('[data-testid="reference-strip"]');
    let capturedOnStrip = false;
    scrollSurface.setPointerCapture = () => { capturedOnStrip = true; };
    await act(async () => button("Preview reference 1").dispatchEvent(new dom.window.MouseEvent("pointerdown", { button: 0, clientX: 100, bubbles: true })));
    assert.equal(capturedOnStrip, true, "capture stays on stationary strip while cards relocate");
    await act(async () => scrollSurface.dispatchEvent(new dom.window.MouseEvent("pointerup", { bubbles: true })));
    await act(async () => button("Insert @sati").click());
    assert.deepEqual(inserted, ["@sati"]);
    assert.deepEqual(ordered, []);
    await act(async () => button("Move reference 2 left").click());
    assert.deepEqual(ordered.at(-1), ["second", "first", "third"]);
    assert.match(document.querySelector("[role=status]").textContent, /Reference 2 moved to position 1/);
    assert.equal(button("Move reference 1 left").disabled, true);
    await act(async () => button("Preview reference 2").dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowRight", altKey: true, bubbles: true })));
    assert.deepEqual(ordered.at(-1), ["first", "third", "second"]);
    await act(async () => button("Move reference 1 to position").click());
    const input = document.querySelector("input[type=number]");
    assert.equal(input.max, "3");
    await act(async () => document.querySelector("form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })));
    await act(async () => Array.from(document.querySelectorAll("button")).find((el) => el.textContent === "Undo reorder").click());
    assert.equal(undo, true);
    // A long prompt reaches the enlarged bound; painted text must share that
    // viewport because the editable layer intentionally has transparent text.
    Object.defineProperty(dom.window.HTMLTextAreaElement.prototype, "scrollHeight", { configurable: true, get: () => 400 });
    await act(async () => root.render(React.createElement(MentionTextarea, { value: Array.from({ length: 20 }, (_, i) => `Visible prompt line ${i}`).join("\n"), references: [], onChange() {} })));
    const textarea = document.querySelector("textarea");
    const overlay = textarea.previousElementSibling;
    assert.equal(textarea.style.height, "240px");
    assert.ok(overlay.classList.contains("max-h-[240px]"), "painted overlay covers the complete expanded text viewport");
    assert.ok(overlay.textContent.includes("Visible prompt line 19"));
    textarea.scrollTop = 120;
    await act(async () => textarea.dispatchEvent(new dom.window.Event("scroll", { bubbles: true })));
    assert.equal(overlay.scrollTop, 120, "painted text follows internal long-prompt scrolling");
  } finally {
    await act(async () => root.unmount());
    await new Promise((resolve) => setTimeout(resolve, 10));
    Object.assign(globalThis, previous);
    dom.window.close();
  }
});

test("fifty staged references expose independent labelled insertion and reorder controls without grip handlebars", () => {
  const prior = globalThis.React; globalThis.React = React;
  return import("react-dom/server").then(({ renderToString }) => {
    const ids = Array.from({ length: 50 }, (_, i) => `occurrence-${i}`);
    const html = renderToString(React.createElement(ReferenceStrip, { store: { referenceIds: ids, referenceImages: ids.map(() => "/same.png"), portraitAssets: [] }, insertTag() {} }));
    assert.equal((html.match(/data-reference-id=/g) || []).length, 50);
    assert.doesNotMatch(html, /data-reference-grip/);
    assert.match(html, /Insert @img50/);
    assert.match(html, /Preview reference 50/);
    assert.match(html, /Move reference 50 left/);
    globalThis.React = prior;
  });
});

test("mention caret mapping preserves literal suffixes at one-to-two-digit boundaries", () => {
  assert.equal(mapMentionSelection("@img1 and @img10 end", "@img50 and @img2 end", 19), 19);
  assert.equal(mapMentionSelection("before @img1 after", "before @img50 after", 18), 19);
});

test("generation folder cues reveal only available scoped names and timestamp handles absent dates", () => {
  const tree = { projects: [{ id: "p", name: "Project", folders: [{ id: "a", name: "Parent", children: [{ id: "b", name: "Child" }] }] }], globalFolders: [] };
  assert.deepEqual(resolveGenerationFolder({ projectId: "p", folderId: "b" }, tree), { label: "Project / Parent / Child", navigable: true });
  assert.deepEqual(resolveGenerationFolder({ projectId: "private", folderId: "b" }, tree), { label: "Project unavailable", navigable: false });
  assert.equal(resolveGenerationFolder({ projectId: "p", folderId: "deleted" }, tree).navigable, false);
  assert.equal(relativeGenerationTime(null), null);
  assert.equal(relativeGenerationTime("garbage"), null);
  assert.match(relativeGenerationTime("2026-10-10T00:00:00Z", Date.parse("2026-10-10T02:00:00Z")), /2.*ago/);
});


test("mixed staging uses fifty total objects and model caps warn without discarding", () => {
  const state = { mode: "image", model: "Seedream 4.5", referenceImages: Array(20).fill("image"), referenceVideos: Array(20).fill("video"), audioNotes: Array(10).fill({ ref: "audio" }) };
  assert.equal(stagedReferenceCount(state), 50);
  assert.match(referenceSubmissionWarning(state), /All attachments remain staged/);
  assert.equal(state.referenceImages.length, 20);
  assert.equal(state.referenceVideos.length, 20);
  assert.equal(state.audioNotes.length, 10);
  assert.equal(uploadContentType({ name: "Finder.JPG", type: "" }), "image/jpeg");
  assert.equal(uploadContentType({ name: "Explorer.MOV", type: "" }), "video/quicktime");
  assert.equal(uploadContentType({ name: "voice.MP3", type: "" }), "audio/mpeg");
});


test("main generation feed shows scoped folder cue, timestamp and stable generation locator", async () => {
  const priorReact = globalThis.React; globalThis.React = React;
  const initial = useStore.getInitialState(); const before = initial.libraryTree;
  initial.libraryTree = { projects: [], globalFolders: [{ id: "folder", name: "Visible folder", children: [] }] };
  try {
    const { renderToString } = await import("react-dom/server");
    const html = renderToString(React.createElement(FeedBlock, { index: 1, item: { id: "generation", status: "queued", kind: "image", aspectRatio: "1:1", model: "Seedream 4.5", prompt: "prompt", folderId: "folder", createdAt: "2026-10-10T00:00:00Z" } }));
    assert.match(html, /data-generation-id="generation"/);
    assert.match(html, /Global \/ Visible folder/);
    assert.match(html, /dateTime="2026-10-10T00:00:00.000Z"/);
  } finally { initial.libraryTree = before; globalThis.React = priorReact; }
});
