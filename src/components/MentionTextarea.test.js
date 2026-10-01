import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToString } from "react-dom/server";
import { MentionTextarea, attachedMediaSuggestions } from "./MentionTextarea.jsx";
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
    assert.match(html, /text-brand">@audio1<\/span>/);
    assert.match(html, /text-brand">@AUDIO2<\/span>/);
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
    assert.match(html, /text-brand">@sati<\/span>/);
    assert.match(html, /text-brand">@scene1<\/span>/);
    assert.match(html, /text-brand">@img1<\/span>/);
    assert.match(html, /text-red-300">@mystery<\/span>/);
  } finally {
    globalThis.React = previousReact;
  }
});

test("informal tags highlight as amber when valid reference exists and red when out of range", () => {
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
    assert.match(html, /text-red-300">@image 5<\/span>/);
  } finally {
    globalThis.React = previousReact;
  }
});

test("attachedMediaSuggestions matches video query variants", () => {
  assert.deepEqual(attachedMediaSuggestions("video", 2, 0).map((s) => s.tag), ["@vid1", "@vid2"]);
  assert.deepEqual(attachedMediaSuggestions("video1", 2, 0).map((s) => s.tag), ["@vid1"]);
});
