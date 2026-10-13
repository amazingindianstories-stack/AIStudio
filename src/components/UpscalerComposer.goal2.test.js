import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToString } from "react-dom/server";
import { UpscalerComposer } from "./UpscalerComposer.jsx";
import { useStore } from "../lib/store";

test("Magnific variants expose only accepted source and control groups", () => {
  const previousReact = globalThis.React;
  globalThis.React = React;
  const initial = useStore.getInitialState();
  const before = { ...initial };
  try {
    for (const model of ["Magnific Creative", "Magnific Precision V2", "Magnific Precision V1"]) {
      Object.assign(initial, { upscalerImage: { url: "/api/media/test.png", name: "Original sheet.png" }, upscalerParams: { ...before.upscalerParams, model } });
      const html = renderToString(React.createElement(UpscalerComposer));
      assert.match(html, /Original sheet.png/);
      assert.match(html, /Replace image/);
      assert.match(html, /sticky bottom-0/);
      assert.match(html, /Drag here to replace/);
      if (model === "Magnific Creative") {
        assert.match(html, /Fine-Tuning Controls/);
        assert.doesNotMatch(html, /type="range"/); // advanced initially folded
        assert.doesNotMatch(html, /Smart Grain/);
      } else {
        assert.match(html, /Smart Grain/);
        assert.doesNotMatch(html, /Fine-Tuning Controls/);
        assert.doesNotMatch(html, /Engine/);
        if (model.endsWith("V1")) assert.doesNotMatch(html, /Scale Factor/);
        else assert.match(html, /Optimization Flavor/);
      }
    }
  } finally {
    Object.assign(initial, before);
    globalThis.React = previousReact;
  }
});
