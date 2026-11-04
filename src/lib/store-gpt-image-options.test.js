import assert from "node:assert/strict";
import test from "node:test";
import { restoreComposerDraft, useStore } from "./store";
import {
  imageBackgroundsForModel,
  imageQualitiesForModel,
  imageSizeFor,
  isExperimentalImageSize,
  resolutionLabel,
  resolutionsForModel,
} from "./config";
import { capability } from "./model-registry";

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

test("GPT Image 2.5 offers five qualities, two backgrounds and exact sizes per tier; other models offer none", () => {
  for (const model of GPT_IMAGE) {
    assert.deepEqual(imageQualitiesForModel(model), ["low", "medium", "high", "xhigh", "max"]);
    assert.deepEqual(imageBackgroundsForModel(model), ["opaque", "transparent"]);
    assert.deepEqual(resolutionsForModel(model, "image"), ["1K", "2K", "4K"]);
    assert.equal(imageSizeFor(model, "3:2", "1K"), "1536x1024");
    assert.equal(resolutionLabel(model, "9:16", "4K"), "4K · 2160x3840");
    assert.deepEqual(["1K", "2K", "4K"].map((tier) => isExperimentalImageSize(model, "1:1", tier)), [false, true, true]);
    assert.deepEqual(["1K", "2K", "4K"].map((tier) => isExperimentalImageSize(model, "21:9", tier)), [false, false, true]);
    assert.equal(imageSizeFor(model, "4:1", "1K"), null);
  }
  for (const model of ["Nano Banana Pro", "Seedream 4.5", "Seedance 2.5"]) {
    assert.deepEqual(imageQualitiesForModel(model), []);
    assert.deepEqual(imageBackgroundsForModel(model), []);
    assert.equal(imageSizeFor(model, "1:1", "2K"), null);
    assert.equal(resolutionLabel(model, "1:1", "2K"), "2K");
    assert.equal(isExperimentalImageSize(model, "1:1", "4K"), false);
  }
});

test("every GPT Image 2.5 size meets OpenAI's documented constraints and keeps the documented 1K sizes", () => {
  const sizes = capability("GPT Image 2.5 Flare", "imageSizes", null);
  assert.deepEqual(capability("GPT Image 2.5 Sunburst", "imageSizes", null), sizes);
  assert.deepEqual(Object.keys(sizes), capability("GPT Image 2.5 Flare", "aspectRatios", []));
  assert.deepEqual([sizes["1:1"]["1K"], sizes["3:2"]["1K"], sizes["2:3"]["1K"]], ["1024x1024", "1536x1024", "1024x1536"]);
  for (const [ratio, tiers] of Object.entries(sizes)) {
    assert.deepEqual(Object.keys(tiers), ["1K", "2K", "4K"]);
    const [across, down] = ratio.split(":").map(Number);
    for (const size of Object.values(tiers)) {
      const [width, height] = size.split("x").map(Number);
      assert.equal(width % 16 + height % 16, 0, size);
      assert.ok(Math.max(width, height) <= 3840 && Math.max(width, height) <= 3 * Math.min(width, height), size);
      assert.ok(width * height >= 655360 && width * height <= 8294400, size);
      assert.equal(width * down, height * across, size);
    }
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
