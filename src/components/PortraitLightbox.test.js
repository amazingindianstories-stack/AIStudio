import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToString } from "react-dom/server";
import { PortraitLightbox } from "./PortraitLightbox.jsx";

const render = (props) => {
  const previousReact = globalThis.React;
  globalThis.React = React;
  try {
    return renderToString(React.createElement(PortraitLightbox, { onClose() {}, onSelectAsset() {}, onAttach() {}, onDelete() {}, onRename() {}, ...props }));
  } finally {
    globalThis.React = previousReact;
  }
};

const portrait = { id: "portrait-456", name: "Commander Arjun", imageUrl: "/api/media/uploads/portrait/arjun", state: "ready", message: null, createdBy: { name: "Pankaj" }, createdAt: 1_790_000_000_000 };

test("PortraitLightbox shows the portrait, its name and who added it, with no provider or group details", () => {
  const html = render({ asset: portrait, assets: [portrait, { ...portrait, id: "other" }] });
  assert.match(html, /Commander Arjun/);
  assert.match(html, /Pankaj/);
  assert.match(html, /1(<!-- -->)? of (<!-- -->)?2/);
  assert.match(html, /object-contain/);
  assert.match(html, /\/api\/media\/uploads\/portrait\/arjun/);
  assert.match(html, /Use in Prompt/);
  assert.match(html, /bg-white/);
  assert.match(html, /text-zinc-950/);
  assert.doesNotMatch(html, /byteplus|asset id|Role:|Virtual Portrait|Registration/i);
});

test("an automatically found face has no uploader and says so", () => {
  const html = render({ asset: { ...portrait, createdBy: null, origin: "reference" }, assets: [portrait] });
  assert.match(html, /Added automatically/);
});

test("a portrait that is still being prepared is labelled and one that can't be used cannot go in a prompt", () => {
  assert.match(render({ asset: { ...portrait, state: "preparing" }, assets: [portrait] }), /Preparing/);
  const unusable = render({ asset: { ...portrait, state: "unusable", message: "This image can't be used as a portrait." }, assets: [portrait] });
  assert.match(unusable, /Can&#x27;t be used/);
  assert.match(unusable, /<button[^>]*disabled=""[^>]*>(?:(?!<\/button>).)*Use in Prompt/s);
});

test("PortraitLightbox returns null when no asset is provided", () => {
  assert.equal(render({ asset: null, assets: [] }), "");
});
