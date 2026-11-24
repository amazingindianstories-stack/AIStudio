import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import DropZone from "./DropZone.jsx";

globalThis.React = React;
const render = (props) => renderToStaticMarkup(React.createElement(DropZone, props));

test("DropZone renders the same copy pattern for each kind", () => {
  assert.match(render({ kind: "image" }).replace(/<!-- -->/g, ""), /Drop an image here or <span[^>]*>browse<\/span>/);
  assert.match(render({ kind: "video" }).replace(/<!-- -->/g, ""), /Drop a video here or <span[^>]*>browse<\/span>/);
  assert.match(render({ kind: "audio" }).replace(/<!-- -->/g, ""), /Drop audio here or <span[^>]*>browse<\/span>/);
});

test("DropZone shares geometry classes and renders the hint", () => {
  const html = render({ kind: "video", hint: "MP4 only" });
  assert.match(html, /rounded-2xl border border-dashed/);
  assert.match(html, /h-10 w-10[^"]*rounded-full/);
  assert.match(html, /MP4 only/);
});

test("DropZone invalid drag uses the red state, message and invalid hint", () => {
  const html = render({ kind: "video", dragging: true, dragValid: false, dragMessage: "Videos only", hint: "h", invalidHint: "bad" });
  assert.match(html, /border-red-500\/80/);
  assert.match(html, /Videos only/);
  assert.match(html, /bad/);
  assert.doesNotMatch(html, />h</);
});

test("DropZone is keyboard reachable and disables when asked", () => {
  assert.match(render({ kind: "image" }), /role="button"[^>]*tabindex="0"|tabindex="0"[^>]*role="button"/);
  assert.match(render({ kind: "image", disabled: true }), /aria-disabled="true"/);
  assert.match(render({ kind: "video", uploading: true, progress: 40 }), /Uploading video… 40%/);
});

test("all four pickers use DropZone", () => {
  for (const f of ["UpscalerComposer.jsx", "VideoUpscalerComposer.jsx", "DepthComposer.jsx", "AudioTranscriptionModal.jsx"]) {
    assert.match(readFileSync(new URL(`./${f}`, import.meta.url), "utf8"), /<DropZone/);
  }
});
