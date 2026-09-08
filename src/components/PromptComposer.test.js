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
    });
    assert.equal(initial.referenceLabels, undefined);
    const html = renderToString(React.createElement(PromptComposer));
    assert.match(html, /data:image\/png;base64,aGVsbG8=/);
    assert.match(html, /@img1/);
  } finally {
    Object.assign(initial, before);
    globalThis.React = previousReact;
  }
});
