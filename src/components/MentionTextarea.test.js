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
