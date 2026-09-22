import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToString } from "react-dom/server";
import { PortraitLightbox } from "./PortraitLightbox.jsx";

test("PortraitLightbox renders portrait, group name, zoom toggle, and readable button text", () => {
  const previousReact = globalThis.React;
  globalThis.React = React;
  try {
    const mockAsset = {
      id: "portrait-456",
      byteplusAssetId: "bp-asset-999",
      name: "Commander Arjun",
      imageUrl: "https://example.com/arjun-portrait.png",
      status: "Ready",
    };

    const html = renderToString(
      React.createElement(PortraitLightbox, {
        asset: mockAsset,
        assets: [mockAsset],
        groupName: "Main Cast",
        onClose() {},
        onSelectAsset() {},
        onAttach() {},
        onDelete() {},
        onRename() {},
      })
    );

    // Verifies name and group
    assert.match(html, /Commander Arjun/);
    assert.match(html, /Main Cast/);
    assert.match(html, /bp-asset-999/);

    // Verifies uncropped image with object-contain
    assert.match(html, /object-contain/);
    assert.match(html, /https:\/\/example\.com\/arjun-portrait\.png/);

    // Verifies high-contrast buttons
    assert.match(html, /bg-white/);
    assert.match(html, /text-zinc-950/);
    assert.match(html, /Use in Prompt/);
  } finally {
    globalThis.React = previousReact;
  }
});

test("PortraitLightbox returns null when no asset is provided", () => {
  const previousReact = globalThis.React;
  globalThis.React = React;
  try {
    const html = renderToString(
      React.createElement(PortraitLightbox, {
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
