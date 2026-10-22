import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToString } from "react-dom/server";
import { MentionTextarea, attachedMediaSuggestions, replaceTagEverywhere } from "./MentionTextarea.jsx";
test("audio-only attachments offer numbered autocomplete matches", () => {
  assert.deepEqual(attachedMediaSuggestions("AuDiO", 0, 2).map((s) => s.tag), ["@audio1", "@audio2"]);
  assert.deepEqual(attachedMediaSuggestions("audio2", 1, 2).map((s) => s.tag), ["@audio2"]);
  assert.deepEqual(attachedMediaSuggestions("", 1, 1).map((s) => s.tag), ["@vid1", "@audio1"]);
  assert.deepEqual(attachedMediaSuggestions("audio", 1, 0), []);
});

test("attached audio tags highlight as valid while missing references stay invalid", () => {
  const previousReact = globalThis.React;
  globalThis.React = React;
  try {
    const html = renderToString(React.createElement(MentionTextarea, {
      value: "@audio1 @AUDIO2 @audio3 @audio0",
      onChange() {}, references: [], audioRefs: ["a.mp3", "b.wav"],
    }));
    assert.match(html, /bg-mention\/20 text-mention">@audio1<\/span>/);
    assert.match(html, /bg-mention\/20 text-mention">@AUDIO2<\/span>/);
    assert.match(html, /text-red-300">@audio3<\/span>/);
    assert.match(html, /text-red-300">@audio0<\/span>/);
  } finally {
    globalThis.React = previousReact;
  }
});

test("named material tags highlight as valid from assets while unknown tags stay invalid", () => {
  const previousReact = globalThis.React;
  globalThis.React = React;
  try {
    const assets = [
      { slug: "sati", name: "Sati", kind: "character", images: ["/sati.png"] },
      { slug: "scene1", name: "Scene 1", kind: "location", images: ["/scene1.png"] },
    ];
    const html = renderToString(React.createElement(MentionTextarea, {
      value: "@sati in @scene1 with @img1 and @mystery",
      onChange() {},
      references: ["data:image/png;base64,AA=="],
      assets,
    }));
    assert.match(html, /bg-mention\/20 text-mention">@sati<\/span>/);
    assert.match(html, /bg-mention\/20 text-mention">@scene1<\/span>/);
    assert.match(html, /bg-mention\/20 text-mention">@img1<\/span>/);
    assert.match(html, /text-red-300">@mystery<\/span>/);
  } finally {
    globalThis.React = previousReact;
  }
});

test("informal image tags remain amber literal warnings even when out of range", () => {
  const previousReact = globalThis.React;
  globalThis.React = React;
  try {
    const html = renderToString(React.createElement(MentionTextarea, {
      value: "@image 1 and @image1 and @image 5",
      onChange() {},
      references: ["data:image/png;base64,AA=="],
    }));
    assert.match(html, /text-amber-200 ring-1 ring-amber-400\/40">@image 1<\/span>/);
    assert.match(html, /text-amber-200 ring-1 ring-amber-400\/40">@image1<\/span>/);
    assert.match(html, /text-amber-200 ring-1 ring-amber-400\/40">@image 5<\/span>/);
  } finally {
    globalThis.React = previousReact;
  }
});

test("attachedMediaSuggestions matches video query variants", () => {
  assert.deepEqual(attachedMediaSuggestions("video", 2, 0).map((s) => s.tag), ["@vid1", "@vid2"]);
  assert.deepEqual(attachedMediaSuggestions("video1", 2, 0).map((s) => s.tag), ["@vid1"]);
});


test("reserved malformed image tags stay whole and amber while unknown named assets stay distinct", () => {
  const previousReact = globalThis.React; globalThis.React = React;
  try {
    const html = renderToString(React.createElement(MentionTextarea, {
      value: "@img1 @img100 @img0 @img02 @img2x @imgg1 @img @missing_named", onChange() {}, references: ["/one.png", "/two.png"],
    }));
    assert.match(html, /bg-mention\/20 text-mention">@img1<\/span>/);
    for (const token of ["@img100", "@img0", "@img02", "@img2x", "@imgg1", "@img"]) assert.ok(html.includes(`text-amber-200 ring-1 ring-amber-400/40">${token}</span>`), token);
    assert.match(html, /text-red-300">@missing_named<\/span>/);
    assert.match(html, /Literal image-reference text/);
  } finally { globalThis.React = previousReact; }
});

async function withMentionTextarea(initial, run) {
  const { JSDOM } = await import("jsdom");
  const { act } = await import("react");
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost", pretendToBeVisual: true });
  const keys = ["window", "document", "HTMLElement", "requestAnimationFrame", "cancelAnimationFrame", "React", "IS_REACT_ACT_ENVIRONMENT"];
  const previous = Object.fromEntries(keys.map((key) => [key, globalThis[key]]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, React, IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: (fn) => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout });
  dom.window.HTMLElement.prototype.scrollIntoView = function () {};
  // react-dom/client decides at import whether native `input` events exist, so it loads after the DOM.
  const { createRoot } = await import("react-dom/client");
  let setReferences;
  function Harness() {
    const [value, setValue] = React.useState(initial);
    const [references, setRefs] = React.useState(["/a.png", "/b.png"]);
    setReferences = setRefs;
    return React.createElement(MentionTextarea, { value, onChange: setValue, onSubmit() {}, references });
  }
  const root = createRoot(document.querySelector("#root"));
  try {
    await act(async () => root.render(React.createElement(Harness)));
    const ta = document.querySelector("textarea");
    ta.focus();
    const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
    // Keystrokes at the end of the text as the browser delivers them: the value setter leaves the
    // caret after the new character without a `select` event (jsdom's setSelectionRange would fire
    // one), `input` fires, and the selection change React reports through onSelect comes later.
    const type = async (text) => {
      for (const ch of text) {
        await act(async () => {
          Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value").set.call(ta, ta.value + ch);
          ta.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
        });
        await flush();
        await act(async () => { document.dispatchEvent(new dom.window.Event("selectionchange")); });
      }
    };
    const select = async (position) => {
      ta.setSelectionRange(position, position);
      await act(async () => { document.dispatchEvent(new dom.window.Event("selectionchange")); });
    };
    // A click on the prompt as the browser delivers it: the caret moves first, then `click` fires.
    const click = async (position) => {
      ta.focus();
      ta.setSelectionRange(position, position);
      await act(async () => { ta.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
      await flush();
    };
    const press = async (key) => {
      await act(async () => { document.activeElement.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); });
      await flush();
    };
    const search = async (text) => {
      const input = document.activeElement;
      await act(async () => {
        Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set.call(input, text);
        input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      });
      await flush();
    };
    // A closing menu fades out before it leaves the DOM; only an open one counts.
    const menu = () => document.querySelector('[data-tag-replace-menu="open"]');
    const options = () => [...(menu()?.querySelectorAll('[role="option"]') || [])].map((o) => ({ label: o.textContent, selected: o.getAttribute("aria-selected") === "true", thumb: o.querySelector("img")?.getAttribute("src") }));
    await run({ ta, type, select, flush, click, press, search, menu, options, setReferences: (next) => act(async () => setReferences(next)) });
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, previous);
  }
}

test("typing a numbered tag by hand keeps the caret after the digit", async () => {
  await withMentionTextarea("", async ({ ta, type }) => {
    await type("@img1");
    assert.equal(ta.value, "@img1");
    assert.equal(ta.selectionStart, 5, "the next keystroke must land after the digit, not before it");
  });
});

test("replacing a tag rewrites every spelling of it and leaves the caret after the clicked one", () => {
  const text = "@img1 walks past @img2 while @IMG2 waves at @image 2, not a@img2 or @img20";
  const start = text.indexOf("@IMG2");
  assert.deepEqual(replaceTagEverywhere(text, start, "@img3"), {
    text: "@img1 walks past @img3 while @img3 waves at @img3, not a@img2 or @img20",
    caret: "@img1 walks past @img3 while @img3".length,
  });
  assert.equal(replaceTagEverywhere(text, text.indexOf("walks"), "@img3"), null);
});

test("clicking an unresolved tag opens a replace menu of every attached reference, driven by the keyboard", async () => {
  await withMentionTextarea("@img1 walks past @img3 waves", async ({ ta, click, press, menu, options }) => {
    await click(19);
    assert.ok(menu(), "the menu opens on the red @img3");
    assert.match(menu().textContent, /Replace @img3 with:/);
    assert.ok(document.activeElement === menu().querySelector("input"), "focus moves to the search field");
    assert.deepEqual(options().map((o) => o.label), ["@img1uploaded image", "@img2uploaded image"]);
    assert.deepEqual(options().map((o) => o.selected), [false, false], "nothing is highlighted until an arrow key");
    await press("ArrowDown");
    assert.deepEqual(options().map((o) => o.selected), [true, false]);
    await press("ArrowDown");
    await press("ArrowDown");
    assert.deepEqual(options().map((o) => o.selected), [false, true], "the highlight stops at the last reference");
    await press("Enter");
    assert.ok(!menu(), "the menu closes");
    assert.equal(ta.value, "@img1 walks past @img2 waves");
    assert.ok(document.activeElement === ta, "focus returns to the prompt");
    assert.equal(ta.selectionStart, "@img1 walks past @img2".length, "the caret lands right after the replacement");
  });
});

test("the replace menu searches, and Escape closes it without touching the prompt", async () => {
  await withMentionTextarea("a @imgg2 b", async ({ ta, click, press, search, menu, options }) => {
    await click(4);
    assert.match(menu().textContent, /Replace @imgg2 with:/, "a misspelled tag opens the menu too");
    await search("2");
    assert.deepEqual(options().map((o) => [o.label, o.selected]), [["@img2uploaded image", true]]);
    await search("9");
    assert.deepEqual(options(), []);
    await press("Escape");
    assert.ok(!menu(), "the menu closes");
    assert.equal(ta.value, "a @imgg2 b");
    assert.ok(document.activeElement === ta, "focus returns to the prompt");
    assert.equal(ta.selectionStart, 4, "the caret goes back where the click put it");
    await click(5);
    await search("2");
    await press("Enter");
    assert.equal(ta.value, "a @img2 b");
  });
});

test("clicking plain text or the edge of a tag keeps the normal caret behaviour", async () => {
  await withMentionTextarea("@img1 walks", async ({ click, menu }) => {
    await click(8);
    assert.ok(!menu());
    await click(5);
    assert.ok(!menu(), "a caret at the tag's end edge is a click past it, not on it");
    await click(2);
    assert.ok(menu(), "a valid tag opens the menu as well, like a Higgsfield chip");
  });
});

test("after a reorder the replace menu lists references in their new slots", async () => {
  await withMentionTextarea("@img1 then @img2", async ({ click, options, press, setReferences }) => {
    await setReferences(["/b.png", "/a.png"]);
    await click(2);
    assert.deepEqual(options().map((o) => o.thumb), ["/b.png", "/a.png"]);
    await press("Escape");
  });
});
