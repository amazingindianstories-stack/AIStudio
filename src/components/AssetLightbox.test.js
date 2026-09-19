import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToString } from "react-dom/server";
import { AssetLightbox } from "./AssetLightbox.jsx";

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
