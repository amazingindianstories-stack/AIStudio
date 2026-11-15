import test from "node:test";
import assert from "node:assert/strict";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { createRoot } from "react-dom/client";
import { DetailModal } from "./DetailModal.jsx";
import { MediaCard } from "./MediaCard.jsx";
import { FeedBlock } from "./ConversationPanel.jsx";
import { useStore } from "../lib/store.js";
import { __setMediaResolverFetch } from "../lib/media-resolver.js";
import { generationPieces, layeredResultLabel, pieceDownload } from "../lib/layered-generations.js";

const fixture = {
  id: "layered", kind: "image", status: "succeeded", model: "Seedream 5.5",
  prompt: "Extract layers", aspectRatio: "3:2", filename: "unsorted_0205.png",
  url: "/api/media/generations/background.png",
  referenceImages: ["/api/media/references/source.jpg"],
  layers: [
    { url: "/api/media/generations/layers/divider.png", zIndex: 1, width: 633, height: 1655 },
    { url: "/api/media/generations/layers/profile.png", zIndex: 2, width: 979, height: 1072 },
    { url: "/api/media/generations/layers/standing.png", zIndex: 3, width: 764, height: 1372 },
  ],
};

async function harness(item, run, Component = DetailModal) {
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
  const calls = [];
  useStore.setState({
    activeId: item.id, activeSource: "single", items: [item], threadItems: [], looseItems: [],
    selectedIds: [], libraryTree: { globalFolders: [], projects: [] },
    addReferenceFromUrl: (url) => calls.push(["reference", url]),
    setAsFirstFrame: (url) => calls.push(["first", url]),
    setAsLastFrame: (url) => calls.push(["last", url]),
  });
  const root = createRoot(document.getElementById("root"));
  try {
    await act(async () => root.render(React.createElement(Component, { item, index: 1 })));
    await run(calls);
  } finally {
    await act(async () => root.unmount());
    useStore.setState(original, true);
    Object.assign(globalThis, previous);
    dom.window.close();
  }
}

const button = (label) => [...document.querySelectorAll("button")].find((node) => node.textContent.trim() === label);
const select = async (label) => act(async () => button(label).click());
async function waitForViewerImage() {
  for (let attempt = 0; attempt < 50; attempt++) {
    const image = document.querySelector("[data-viewer-image]");
    if (image) return image;
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  }
  assert.fail("Viewer master did not resolve");
}
const download = () => [...document.querySelectorAll("a")].find((node) => node.textContent.trim().startsWith("Download"));

test("piece manifest preserves original URLs, sorts z-order and distinguishes the source", () => {
  const input = { ...fixture, layers: [...fixture.layers].reverse() };
  const before = JSON.stringify(input);
  const pieces = generationPieces(input);
  assert.deepEqual(pieces.map((piece) => piece.label), ["Background", "Layer 1", "Layer 2", "Layer 3", "Source"]);
  assert.equal(pieces[1].url, fixture.layers[0].url);
  assert.equal(layeredResultLabel(pieces), "Background + 3 layers");
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(pieceDownload(fixture, pieces[2]), {
    url: `${fixture.layers[1].url}?inline=1`, filename: "unsorted_0205_layer_2.png",
  });
  assert.equal(pieceDownload(fixture, pieces[4]).filename, "unsorted_0205_source.jpg");
  assert.deepEqual(generationPieces({ ...fixture, layers: null }), []);
  assert.deepEqual(generationPieces({ ...fixture, layers: [{ url: null }] }), []);
  assert.equal(generationPieces({ ...fixture, referenceImages: [] }).length, 4);
  const portrait = generationPieces({ ...fixture, referenceImages: ["asset://portrait-1"] }, [
    { id: "portrait-1", imageUrl: "/api/media/portraits/portrait.png" },
  ]).at(-1);
  assert.equal(portrait.label, "Source");
  assert.equal(portrait.url, "/api/media/portraits/portrait.png");
  assert.equal(layeredResultLabel(generationPieces({ ...fixture, layers: [fixture.layers[0]] })), "Background + 1 layer");
});

test("the viewer exposes all pieces visibly and each chosen master drives download", async () => {
  await harness(fixture, async () => {
    const picker = document.querySelector('[data-testid="layer-list"]');
    assert.equal(picker.querySelectorAll("img").length, 5);
    assert.equal(picker.querySelectorAll(".layer-checkerboard").length, 5);
    assert.match(picker.textContent, /Background \+ 3 layers/);
    for (const piece of generationPieces(fixture)) {
      await select(piece.label);
      assert.equal(button(piece.label).getAttribute("aria-pressed"), "true");
      assert.equal(document.querySelectorAll('[data-testid="layer-list"] [aria-pressed="true"]').length, 1);
      assert.equal((await waitForViewerImage()).getAttribute("src"), piece.url);
      assert.equal(download().textContent.trim(), `Download ${piece.label.toLowerCase()}`);
      assert.equal(download().getAttribute("href"), pieceDownload(fixture, piece).url);
      assert.equal(download().getAttribute("download"), pieceDownload(fixture, piece).filename);
      assert.ok(button(`Use ${piece.label.toLowerCase()} as reference`));
    }
    const image = await waitForViewerImage();
    await act(async () => image.dispatchEvent(new window.Event("load")));
    assert.equal(document.querySelector("[data-viewer-stand-in]"), null, "transparent masters must not paint over their own thumbnail");
    // Item navigation must not carry a layer selection over to another result.
    const next = { ...fixture, id: "next-layered", url: "/api/media/generations/next.png" };
    await act(async () => useStore.setState({ items: [next], activeId: next.id }));
    assert.equal(button("Background").getAttribute("aria-pressed"), "true");
    assert.equal((await waitForViewerImage()).getAttribute("src"), next.url);
  });
});

test("reference and video-frame actions use the chosen foreground or source", async () => {
  for (const label of ["Background", "Layer 1", "Layer 2", "Layer 3", "Source"]) {
    const piece = generationPieces(fixture).find((candidate) => candidate.label === label);
    for (const [action, text] of [["reference", `Use ${label.toLowerCase()} as reference`], ["first", "Use as first frame"], ["last", "Use as last frame"]]) {
      await harness(fixture, async (calls) => {
        await select(label);
        await select(text);
        assert.deepEqual(calls, [[action, piece.url]]);
      });
    }
  }
});

test("the picker exposes every foreground even when the card preview is capped", async () => {
  const many = { ...fixture, layers: Array.from({ length: 9 }, (_, index) => ({
    url: `/api/media/generations/layers/layer-${index}.png`, zIndex: index,
  })) };
  await harness(many, async () => {
    assert.equal(document.querySelectorAll('[data-testid="layer-list"] button').length, 11);
    await select("Layer 9");
    assert.equal((await waitForViewerImage()).getAttribute("src"), many.layers[8].url);
    assert.equal(download().textContent.trim(), "Download layer 9");
  });
});

test("ordinary single images keep their viewer and actions", async () => {
  const plain = { ...fixture, layers: null };
  await harness(plain, async (calls) => {
    assert.equal(document.querySelector('[data-testid="layer-list"]'), null);
    assert.equal((await waitForViewerImage()).getAttribute("src"), plain.url);
    assert.equal(download().textContent.trim(), "Download");
    assert.equal(download().getAttribute("href"), `/api/generations/${plain.id}/download?signed=1`);
    await select("Use as reference");
    assert.deepEqual(calls, [["reference", plain.url]]);
  });
});

test("library and conversation cards show background and foreground thumbnails with a count", async () => {
  for (const Component of [MediaCard, FeedBlock]) {
    await harness(fixture, async () => {
      const preview = document.querySelector("[data-layered-preview]");
      assert.match(preview.textContent, /Background \+ 3 layers/);
      assert.deepEqual([...preview.querySelectorAll("img")].map((image) => image.alt), ["Background", "Layer 1", "Layer 2", "Layer 3"]);
    }, Component);
    await harness({ ...fixture, layers: [] }, async () => {
      assert.equal(document.querySelector("[data-layered-preview]"), null);
    }, Component);
  }
});
