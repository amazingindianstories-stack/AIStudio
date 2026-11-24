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

test("Video mode renders each Magnific video upscaler with only its documented controls", () => {
  const previousReact = globalThis.React;
  globalThis.React = React;
  const initial = useStore.getInitialState();
  const before = { ...initial };
  try {
    Object.assign(initial, { upscalerMedia: "image" });
    assert.match(renderToString(React.createElement(UpscalerComposer)), /Replace image|Drop an image here/);
    for (const model of ["Magnific Video Creative", "Magnific Video Creative Turbo", "Magnific Video Precision", "Magnific Video Topaz"]) {
      Object.assign(initial, {
        upscalerMedia: "video",
        upscalerVideo: { url: "/api/media/generations/clip.mp4", name: "Hall pan.mp4" },
        videoUpscalerParams: { ...before.videoUpscalerParams, model },
      });
      const html = renderToString(React.createElement(UpscalerComposer));
      assert.match(html, /Hall pan.mp4/);
      assert.match(html, /Replace video/);
      assert.match(html, /Output Resolution/);
      assert.match(html, /aria-checked="true"[^>]*>.*?Video/s);
      assert.doesNotMatch(html, /Scale Factor|Filter NSFW/);
      if (model === "Magnific Video Topaz") {
        assert.match(html, /Enhancement Model/);
        assert.match(html, /Keeps the source frame rate/);
        assert.doesNotMatch(html, /Output Format|Flavor|FPS boost|Frame Interpolation/);
      } else {
        assert.match(html, /Output Format/);
        assert.match(html, /FPS boost/);
        assert.match(html, /Sharpen/);
        assert.match(html, /Smart Grain/);
        if (model === "Magnific Video Precision") {
          assert.match(html, /Strength/);
          assert.doesNotMatch(html, /Creativity|Flavor/);
        } else {
          assert.match(html, /Creativity/);
          assert.match(html, /Flavor/);
        }
      }
    }
    Object.assign(initial, { videoUpscalerParams: { ...before.videoUpscalerParams, model: "Magnific Video Topaz", targetFps: 30 } });
    assert.match(renderToString(React.createElement(UpscalerComposer)), /Frame Interpolation/);
  } finally {
    Object.assign(initial, before);
    globalThis.React = previousReact;
  }
});

test("Empty feed hides the Welcome hero on upscale and depth, keeps it for video and image", async () => {
  const previousReact = globalThis.React;
  globalThis.React = React;
  try {
    const { EmptyFeed } = await import("./ConversationPanel.jsx");
    for (const mode of ["upscale", "depth"]) {
      const html = renderToString(React.createElement(EmptyFeed, { mode }));
      assert.doesNotMatch(html, /Create with/);
      assert.doesNotMatch(html, /Neon-lit Tokyo/);
    }
    assert.match(renderToString(React.createElement(EmptyFeed, { mode: "upscale" })), /Upscaled results appear here/);
    assert.match(renderToString(React.createElement(EmptyFeed, { mode: "video" })), /Create with/);
    const image = renderToString(React.createElement(EmptyFeed, { mode: "image" }));
    assert.match(image, /Create with/);
    assert.doesNotMatch(image, /slow dolly/);
  } finally {
    globalThis.React = previousReact;
  }
});

test("Upscale composers scroll inside their panel instead of growing past the column", () => {
  const previousReact = globalThis.React;
  globalThis.React = React;
  try {
    assert.match(renderToString(React.createElement(UpscalerComposer)), /max-h-\[calc\(100dvh-9rem\)\] overflow-y-auto/);
  } finally {
    globalThis.React = previousReact;
  }
});
