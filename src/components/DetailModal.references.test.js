import test from "node:test";
import assert from "node:assert/strict";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { createRoot } from "react-dom/client";
import { DetailModal } from "./DetailModal.jsx";
import { useStore } from "../lib/store.js";
import { __setMediaResolverFetch } from "../lib/media-resolver.js";

const item = {
  id: "refs", kind: "video", status: "succeeded", model: "Seedance 2.5", prompt: "Sati walks",
  aspectRatio: "16:9", filename: "unsorted_0731.mov", url: "/api/media/generations/out.mov",
  referenceImages: ["/api/media/uploads/image-reference/still.png"],
  referenceVideos: ["/api/media/uploads/video-reference/clip.mov", "asset://unresolvable"],
  referenceAudios: ["/api/media/uploads/audio-reference/voice.wav"],
};

async function harness(run) {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost", pretendToBeVisual: true });
  const names = ["window", "document", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement", "React", "IS_REACT_ACT_ENVIRONMENT", "ResizeObserver", "IntersectionObserver", "requestAnimationFrame", "cancelAnimationFrame"];
  const previous = Object.fromEntries(names.map((name) => [name, globalThis[name]]));
  for (const name of names.filter((name) => name.startsWith("HTML"))) globalThis[name] = dom.window[name];
  Object.assign(globalThis, {
    window: dom.window, document: dom.window.document, React, IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (cb) => setTimeout(cb, 0), cancelAnimationFrame: clearTimeout,
    ResizeObserver: class { observe() {} disconnect() {} },
    IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
  });
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  __setMediaResolverFetch(async () => ({ ok: true, json: async () => ({ items: [] }) }));
  const original = useStore.getState();
  useStore.setState({
    activeId: item.id, activeSource: "single", items: [item], threadItems: [], looseItems: [],
    selectedIds: [], libraryTree: { globalFolders: [], projects: [] },
  });
  const root = createRoot(document.getElementById("root"));
  try {
    await act(async () => root.render(React.createElement(DetailModal)));
    await run();
  } finally {
    await act(async () => root.unmount());
    useStore.setState(original, true);
    Object.assign(globalThis, previous);
    dom.window.close();
  }
}

const heading = (text) => [...document.querySelectorAll("p")].find((node) => node.textContent.trim() === text);
const download = (label) => document.querySelector(`a[aria-label="Download original ${label}"]`);

test("the detail panel lists video and audio references beside images, each downloadable as its original file", async () => {
  await harness(async () => {
    assert.ok(heading("Reference images"));
    assert.ok(heading("Reference videos"));
    assert.ok(heading("Reference audio"));

    const videos = document.querySelectorAll('[data-reference-kind="video"]');
    assert.equal(videos.length, 1, "the unresolvable asset:// video reference is left out");
    assert.match(videos[0].querySelector("video").getAttribute("src"), /^\/api\/media\/uploads\/video-reference\/clip\.mov/);
    const audios = document.querySelectorAll('[data-reference-kind="audio"]');
    assert.equal(audios.length, 1);
    assert.equal(audios[0].querySelector("audio").getAttribute("src"), "/api/media/uploads/audio-reference/voice.wav");

    const expected = [
      ["reference image 1", "/api/media/uploads/image-reference/still.png?inline=1", "still.png"],
      ["reference video 1", "/api/media/uploads/video-reference/clip.mov?inline=1", "clip.mov"],
      ["reference audio 1", "/api/media/uploads/audio-reference/voice.wav?inline=1", "voice.wav"],
    ];
    for (const [label, href, name] of expected) {
      const link = download(label);
      assert.ok(link, `${label} has a download link`);
      assert.equal(link.getAttribute("href"), href);
      assert.equal(link.getAttribute("download"), name);
      assert.doesNotMatch(link.getAttribute("href"), /[?&]w=/);
    }
    assert.equal(download("reference video 2"), null);
  });
});
