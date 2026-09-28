import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToString } from "react-dom/server";
import { PromptComposer } from "./PromptComposer.jsx";
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
    assert.match(html, /text-brand">@audio1<\/span>/);
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

