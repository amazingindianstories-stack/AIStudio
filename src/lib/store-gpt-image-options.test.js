import assert from "node:assert/strict";
import test from "node:test";
import { restoreComposerDraft, useStore } from "./store";
import {
  experimentalResolutionsForModel,
  imageBackgroundsForModel,
  imageQualitiesForModel,
  resolutionsForModel,
} from "./config";

const GPT_IMAGE = ["GPT Image 2.5 Sunburst", "GPT Image 2.5 Flare"];

function withStore(patch, run) {
  const previous = useStore.getState();
  const fetchBefore = globalThis.fetch;
  useStore.setState({ generating: false, items: [], threadItems: [], pendingItems: [], referenceImages: [], referenceVideos: [],
    referenceAudios: [], audioNotes: [], batchCount: 1, prompt: "A lighthouse at dusk", ...patch });
  return Promise.resolve(run()).finally(() => {
    globalThis.fetch = fetchBefore;
    useStore.setState(previous, true);
  });
}

async function sentBody(patch) {
  const bodies = [];
  const consoleError = console.error;
  console.error = () => {};
  try {
    await withStore(patch, async () => {
      globalThis.fetch = async (url, init) => {
        if (String(url).includes("/api/generate/")) bodies.push(JSON.parse(init.body));
        return new Response(JSON.stringify({ error: { message: "stop here" } }), { status: 400 });
      };
      await useStore.getState().generate();
    });
  } finally {
    console.error = consoleError;
  }
  assert.equal(bodies.length, 1);
  return bodies[0];
}

test("GPT Image 2.5 offers five qualities, two backgrounds and marks 2K/4K experimental; other models offer none", () => {
  for (const model of GPT_IMAGE) {
    assert.deepEqual(imageQualitiesForModel(model), ["low", "medium", "high", "xhigh", "max"]);
    assert.deepEqual(imageBackgroundsForModel(model), ["opaque", "transparent"]);
    assert.deepEqual(experimentalResolutionsForModel(model), ["2K", "4K"]);
    assert.deepEqual(resolutionsForModel(model, "image"), ["1K", "2K", "4K"]);
  }
  for (const model of ["Nano Banana Pro", "Seedream 4.5", "Seedance 2.5"]) {
    assert.deepEqual(imageQualitiesForModel(model), []);
    assert.deepEqual(imageBackgroundsForModel(model), []);
    assert.deepEqual(experimentalResolutionsForModel(model), []);
  }
});

test("quality and background default to high/opaque, survive a switch between the two models and reset elsewhere", () =>
  withStore({ mode: "image", model: "GPT Image 2.5 Flare" }, () => {
    const state = useStore.getState();
    assert.equal(useStore.getInitialState().imageQuality, "high");
    assert.equal(useStore.getInitialState().imageBackground, "opaque");
    state.setImageQuality("max");
    state.setImageBackground("transparent");
    useStore.getState().setModel("GPT Image 2.5 Sunburst");
    assert.equal(useStore.getState().imageQuality, "max");
    assert.equal(useStore.getState().imageBackground, "transparent");
    useStore.getState().setImageQuality("auto");
    useStore.getState().setImageBackground("auto");
    assert.equal(useStore.getState().imageQuality, "high");
    assert.equal(useStore.getState().imageBackground, "opaque");
    useStore.getState().setImageQuality("low");
    useStore.getState().setModel("Nano Banana Pro");
    assert.equal(useStore.getState().imageQuality, "high");
    assert.equal(useStore.getState().imageBackground, "opaque");
  }));

test("generate sends the chosen quality and background only for GPT Image 2.5", async () => {
  for (const model of GPT_IMAGE) {
    const body = await sentBody({ mode: "image", model, aspectRatio: "1:1", resolution: "1K", imageQuality: "xhigh", imageBackground: "transparent" });
    assert.equal(body.model, model);
    assert.equal(body.imageQuality, "xhigh");
    assert.equal(body.imageBackground, "transparent");
  }
  const other = await sentBody({ mode: "image", model: "Nano Banana Pro", aspectRatio: "1:1", resolution: "1K", imageQuality: "max", imageBackground: "transparent" });
  assert.equal("imageQuality" in other, false);
  assert.equal("imageBackground" in other, false);
  const video = await sentBody({ mode: "video", model: "Seedance 2.5", aspectRatio: "16:9", resolution: "720p", duration: 5, imageQuality: "max" });
  assert.equal("imageQuality" in video, false);
});

test("Edit & retry reopens a GPT Image row with its stored quality and background; older rows get the defaults", () =>
  withStore({ mode: "image", model: "Nano Banana Pro" }, async () => {
    const row = { id: "gpt", kind: "image", status: "succeeded", prompt: "scene", model: "GPT Image 2.5 Flare", aspectRatio: "1:1",
      resolution: "4K", imageQuality: "low", imageBackground: "transparent" };
    useStore.setState({ items: [row, { ...row, id: "legacy", imageQuality: undefined, imageBackground: undefined },
      { ...row, id: "nano", model: "Nano Banana Pro", resolution: "2K" }] });
    assert.deepEqual(await useStore.getState().cloneToComposer("gpt"), { ok: true });
    assert.equal(useStore.getState().model, "GPT Image 2.5 Flare");
    assert.equal(useStore.getState().imageQuality, "low");
    assert.equal(useStore.getState().imageBackground, "transparent");
    assert.deepEqual(await useStore.getState().cloneToComposer("legacy"), { ok: true });
    assert.equal(useStore.getState().imageQuality, "high");
    assert.equal(useStore.getState().imageBackground, "opaque");
    useStore.setState({ imageQuality: "max" });
    assert.deepEqual(await useStore.getState().cloneToComposer("nano"), { ok: true });
    assert.equal(useStore.getState().imageQuality, "high");
  }));

test("the local draft keeps a GPT Image choice and drops it for a model without the options", () =>
  withStore({}, () => {
    const previousStorage = globalThis.localStorage;
    const values = new Map();
    globalThis.localStorage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: (key) => values.delete(key),
    };
    try {
      values.set("veevee-draft-settings-v1", JSON.stringify({ mode: "image", model: "GPT Image 2.5 Sunburst", imageQuality: "medium", imageBackground: "transparent" }));
      restoreComposerDraft();
      assert.equal(useStore.getState().imageQuality, "medium");
      assert.equal(useStore.getState().imageBackground, "transparent");
      values.set("veevee-draft-settings-v1", JSON.stringify({ mode: "image", model: "Nano Banana Pro", imageQuality: "medium", imageBackground: "transparent" }));
      restoreComposerDraft();
      assert.equal(useStore.getState().imageQuality, "high");
      assert.equal(useStore.getState().imageBackground, "opaque");
    } finally {
      globalThis.localStorage = previousStorage;
    }
  }));
