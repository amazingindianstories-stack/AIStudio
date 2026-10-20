import assert from "node:assert/strict";
import test from "node:test";
import { MODELS, fallbackModel, isPickerModel, modeAvailable, pickerModels } from "./config";
import { availableModels, isModelAvailable } from "./model-registry";
import { useNotices } from "./notify";
import { composerChoice, restoreComposerDraft, useStore } from "./store";

// What GET /api/auth/me reports with VEEVEE_KLING and VEEVEE_MAGNIFIC_UPSCALE off and Gemini Omni on.
const KLING_AND_MAGNIFIC_OFF = ["seedream-5-pro", "nano-banana-pro", "nano-banana-2-1", "seedance", "seedance-25",
  "gemini-omni-1-1-flash", "depth-anything-local"];
const ALL_ON = MODELS.map((model) => model.id);
const names = (models) => models.map((model) => model.name);

function withStore(patch, run) {
  const previous = useStore.getState();
  const fetchBefore = globalThis.fetch;
  const storageBefore = globalThis.localStorage;
  const values = new Map();
  globalThis.localStorage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key) };
  useNotices.setState({ notices: [] });
  useStore.setState({ items: [], threadItems: [], pendingItems: [], generating: false, availableModelIds: null, prompt: "",
    referenceImages: [], ...patch });
  return Promise.resolve(run(values)).finally(() => {
    globalThis.fetch = fetchBefore;
    globalThis.localStorage = storageBefore;
    useNotices.setState({ notices: [] });
    useStore.setState(previous, true);
  });
}

test("until the server answers, every offered model is available and the pickers match MODELS", () => {
  assert.deepEqual(availableModels(null), MODELS);
  for (const mode of ["image", "video", "upscale", "depth"]) {
    assert.deepEqual(pickerModels(null, mode), MODELS.filter((model) => model.kind === mode));
    assert.equal(modeAvailable(mode, null), true);
  }
  assert.equal(isModelAvailable("Kling Image 3.0", null), true);
  assert.equal(isModelAvailable("Gemini Omni Flash", null), false, "a retired model is never offered");
  assert.equal(isModelAvailable("Higgsfield Seedance 2.0", null), false, "an unoffered model is never offered");
  assert.equal(isModelAvailable("No Such Model", null), false);
});

test("the registry filter hides switched-off models from every picker by name or id", () => {
  assert.deepEqual(names(pickerModels(KLING_AND_MAGNIFIC_OFF, "image")), ["Seedream 5.0 Pro", "Nano Banana Pro", "Nano Banana 2.1"]);
  assert.deepEqual(names(pickerModels(KLING_AND_MAGNIFIC_OFF, "video")), ["Seedance 2.0", "Seedance 2.5", "Gemini Omni Flash 1.1"]);
  assert.deepEqual(pickerModels(KLING_AND_MAGNIFIC_OFF, "upscale"), []);
  assert.equal(modeAvailable("upscale", KLING_AND_MAGNIFIC_OFF), false);
  assert.equal(modeAvailable("depth", KLING_AND_MAGNIFIC_OFF), true);
  for (const name of ["Kling Image 3.0", "kling-image-3", "Kling Image 2.1", "Magnific Creative", "magnific-video-topaz"]) {
    assert.equal(isModelAvailable(name, KLING_AND_MAGNIFIC_OFF), false, name);
  }
  assert.equal(isModelAvailable("Nano Banana Pro", KLING_AND_MAGNIFIC_OFF), true);
  assert.deepEqual(availableModels(ALL_ON), MODELS);
});

test("upscalers split by media, so each upscaler picker lists only its own", () => {
  assert.deepEqual(names(pickerModels(ALL_ON, "upscale", "image")), ["Magnific Creative", "Magnific Precision V2", "Magnific Precision V1"]);
  assert.deepEqual(names(pickerModels(ALL_ON, "upscale", "video")),
    ["Magnific Video Creative", "Magnific Video Creative Turbo", "Magnific Video Precision", "Magnific Video Topaz"]);
  assert.equal(isPickerModel("Magnific Creative", ALL_ON, "upscale", "video"), false);
});

test("the fallback is the mode default when available, otherwise the first model offered", () => {
  assert.equal(fallbackModel("image", KLING_AND_MAGNIFIC_OFF), "Nano Banana Pro");
  assert.equal(fallbackModel("video", KLING_AND_MAGNIFIC_OFF), "Seedance 2.0");
  assert.equal(fallbackModel("image", ["kling-image-21", "seedream-5-pro"]), "Seedream 5.0 Pro");
  assert.equal(fallbackModel("upscale", ALL_ON, "video"), "Magnific Video Creative");
  assert.equal(fallbackModel("upscale", KLING_AND_MAGNIFIC_OFF, "image"), null);
  assert.deepEqual(composerChoice("Kling Image 3.0", "image", KLING_AND_MAGNIFIC_OFF),
    { model: "Nano Banana Pro", notice: "Kling Image 3.0 isn't available right now. Using Nano Banana Pro instead." });
  assert.deepEqual(composerChoice("Gemini Omni Flash", "video", KLING_AND_MAGNIFIC_OFF), { model: "Gemini Omni Flash 1.1", notice: null },
    "a retired model still reopens on its replacement without a notice");
});

test("an availability answer moves a selected switched-off model onto the fallback once, without looping", () =>
  withStore({ mode: "image", model: "Kling Image 2.1", resolution: "2K", aspectRatio: "16:9" }, (values) => {
    let writes = 0;
    const unsubscribe = useStore.subscribe(() => { writes += 1; });
    try {
      useStore.getState().applyModelAvailability(KLING_AND_MAGNIFIC_OFF);
      const state = useStore.getState();
      assert.deepEqual([state.mode, state.model, state.resolution, state.aspectRatio], ["image", "Nano Banana Pro", "2K", "16:9"]);
      assert.deepEqual(state.availableModelIds, KLING_AND_MAGNIFIC_OFF);
      assert.deepEqual(JSON.parse(values.get("veevee-model-availability-v1")), KLING_AND_MAGNIFIC_OFF);
      assert.deepEqual(useNotices.getState().notices, [], "a background fallback is silent");
      const settled = writes;
      useStore.getState().applyModelAvailability([...KLING_AND_MAGNIFIC_OFF]);
      assert.equal(writes, settled, "the same answer again changes nothing");
    } finally {
      unsubscribe();
    }
  }));

test("with every upscaler switched off, Upscale mode falls back and the upscaler selections stay valid", () =>
  withStore({ mode: "upscale", upscalerMedia: "video" }, () => {
    useStore.getState().applyModelAvailability(KLING_AND_MAGNIFIC_OFF);
    assert.equal(useStore.getState().mode, "image");
    assert.equal(useStore.getState().model, "Nano Banana Pro");

    useStore.setState({ upscalerParams: { ...useStore.getState().upscalerParams, model: "Magnific Precision V1" } });
    useStore.getState().applyModelAvailability(["nano-banana-pro", "magnific-creative", "magnific-video-topaz"]);
    const state = useStore.getState();
    assert.equal(state.upscalerParams.model, "Magnific Creative");
    assert.equal(state.videoUpscalerParams.model, "Magnific Video Topaz");
  }));

test("a malformed or failed availability answer leaves the pickers and the composer alone", () =>
  withStore({ mode: "image", model: "Kling Image 3.0" }, async () => {
    for (const value of [undefined, null, "kling-image-3", [1, 2], { models: [] }]) {
      useStore.getState().applyModelAvailability(value);
    }
    assert.equal(useStore.getState().availableModelIds, null);
    assert.equal(useStore.getState().model, "Kling Image 3.0");

    globalThis.fetch = async () => { throw new Error("offline"); };
    await useStore.getState().loadMe();
    assert.equal(useStore.getState().availableModelIds, null);
    assert.equal(useStore.getState().model, "Kling Image 3.0");

    globalThis.fetch = async () => new Response(JSON.stringify({ user: { id: "u-1" } }), { status: 200 });
    await useStore.getState().loadMe();
    assert.equal(useStore.getState().availableModelIds, null, "an older API without availability changes nothing");
  }));

test("the session answer applies availability", () =>
  withStore({ mode: "image", model: "Kling Image 3.0" }, async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({ user: { id: "u-1" }, availability: { models: KLING_AND_MAGNIFIC_OFF } }), { status: 200 });
    await useStore.getState().loadMe();
    assert.deepEqual(useStore.getState().availableModelIds, KLING_AND_MAGNIFIC_OFF);
    assert.equal(useStore.getState().model, "Nano Banana Pro");
  }));

test("a saved Kling composer survives a stale cached list that says Kling is off once the session says it is on", () =>
  withStore({ mode: "video", model: "Seedance 2.0" }, async (values) => {
    values.set("veevee-model-availability-v1", JSON.stringify(KLING_AND_MAGNIFIC_OFF));
    values.set("veevee-draft-settings-v1", JSON.stringify({ mode: "image", model: "Kling Image 3.0", aspectRatio: "3:2", resolution: "1K",
      batchCount: 3 }));
    const saved = () => {
      const state = useStore.getState();
      return [state.mode, state.model, state.aspectRatio, state.resolution, state.batchCount];
    };
    restoreComposerDraft();
    assert.deepEqual(useStore.getState().availableModelIds, KLING_AND_MAGNIFIC_OFF, "the cached list shapes the pickers until the session answers");
    assert.deepEqual(saved(), ["image", "Kling Image 3.0", "3:2", "1K", 3], "the cached list never moves the saved selection");

    globalThis.fetch = async () => new Response(JSON.stringify({ user: { id: "u-1" }, availability: { models: ALL_ON } }), { status: 200 });
    await useStore.getState().loadMe();
    assert.deepEqual(useStore.getState().availableModelIds, ALL_ON);
    assert.deepEqual(saved(), ["image", "Kling Image 3.0", "3:2", "1K", 3]);
    assert.deepEqual(JSON.parse(values.get("veevee-model-availability-v1")), ALL_ON);
  }));

test("a saved composer on a model the session reports off moves onto the fallback when the session answers", () =>
  withStore({ mode: "video", model: "Seedance 2.0" }, async (values) => {
    values.set("veevee-draft-settings-v1", JSON.stringify({ mode: "image", model: "Kling Image 3.0", aspectRatio: "16:9", resolution: "1K" }));
    restoreComposerDraft();
    assert.equal(useStore.getState().model, "Kling Image 3.0");

    globalThis.fetch = async () => new Response(JSON.stringify({ user: { id: "u-1" }, availability: { models: KLING_AND_MAGNIFIC_OFF } }),
      { status: 200 });
    await useStore.getState().loadMe();
    const state = useStore.getState();
    assert.deepEqual([state.mode, state.model, state.aspectRatio, state.resolution], ["image", "Nano Banana Pro", "16:9", "1K"]);
  }));

test("a saved model the catalog no longer has restores as the mode's defaults", () =>
  withStore({ mode: "video", model: "Seedance 2.0", aspectRatio: "16:9", resolution: "1080p", duration: 5 }, (values) => {
    values.set("veevee-draft-settings-v1", JSON.stringify({ mode: "image", model: "No Such Model", resolution: "1080p" }));
    restoreComposerDraft();
    const state = useStore.getState();
    assert.deepEqual([state.mode, state.model, state.aspectRatio, state.resolution], ["image", "Nano Banana Pro", "21:9", "2K"]);
  }));

test("Clone & try on a switched-off model opens the composer on the fallback with a short notice", () =>
  withStore({ availableModelIds: KLING_AND_MAGNIFIC_OFF, mode: "video", model: "Seedance 2.5" }, async () => {
    const row = { id: "k-1", kind: "image", status: "succeeded", prompt: "a lantern", model: "Kling Image 3.0", aspectRatio: "3:2",
      resolution: "2K", referenceImages: ["/api/media/references/k-1.png"], projectId: "p-1" };
    useStore.setState({ items: [row] });
    const notice = "Kling Image 3.0 isn't available right now. Using Nano Banana Pro instead.";
    assert.deepEqual(await useStore.getState().cloneToComposer("k-1"), { ok: true, notice });
    const state = useStore.getState();
    assert.deepEqual([state.mode, state.model, state.prompt, state.referenceImages, state.aspectRatio, state.resolution],
      ["image", "Nano Banana Pro", "a lantern", ["/api/media/references/k-1.png"], "1:1", "2K"],
      "the job's settings are clamped into the fallback's ranges (Nano Banana Pro has no 3:2)");
    assert.deepEqual(useNotices.getState().notices.map(({ text, tone }) => ({ text, tone })), [{ text: notice, tone: "info" }]);
  }));

test("Clone & try on an available model is unchanged and says nothing", () =>
  withStore({ availableModelIds: KLING_AND_MAGNIFIC_OFF }, async () => {
    useStore.setState({ items: [{ id: "n-1", kind: "image", status: "succeeded", prompt: "p", model: "Nano Banana 2.1", aspectRatio: "4:5", resolution: "4K" }] });
    assert.deepEqual(await useStore.getState().cloneToComposer("n-1"), { ok: true });
    assert.equal(useStore.getState().model, "Nano Banana 2.1");
    assert.deepEqual(useNotices.getState().notices, []);
  }));

test("regenerating a switched-off job opens the fallback in the composer and does not submit it", () =>
  withStore({ availableModelIds: KLING_AND_MAGNIFIC_OFF }, async () => {
    let requests = 0;
    globalThis.fetch = async () => { requests += 1; return new Response("{}", { status: 500 }); };
    useStore.setState({ items: [{ id: "k-2", kind: "image", status: "succeeded", prompt: "p", model: "Kling Image 2.1", aspectRatio: "1:1", resolution: "1K", seed: 7 }] });
    assert.deepEqual(await useStore.getState().regenerate("k-2"), { ok: true });
    assert.deepEqual(await useStore.getState().regenerateWithSameSeed("k-2"), { ok: true });
    assert.equal(requests, 0);
    assert.equal(useStore.getState().model, "Nano Banana Pro");
    assert.equal(useStore.getState().seed, null);
  }));

test("a Magnific row cannot reopen or resubmit while every upscaler is off, and says why", () =>
  withStore({ availableModelIds: KLING_AND_MAGNIFIC_OFF, mode: "image" }, async () => {
    let requests = 0;
    globalThis.fetch = async () => { requests += 1; return new Response("{}", { status: 500 }); };
    const row = { id: "m-1", kind: "image", status: "succeeded", model: "Magnific Creative", prompt: "Magnific Creative (2x)", resolution: "2x",
      referenceImages: ["/api/media/references/m-1.png"], upscaleParams: { model: "Magnific Creative" } };
    useStore.setState({ items: [row] });
    const refused = { ok: false, error: "Magnific Creative isn't available right now." };
    assert.deepEqual(await useStore.getState().cloneToComposer("m-1"), refused);
    assert.deepEqual(await useStore.getState().regenerate("m-1"), refused);
    assert.equal(useStore.getState().mode, "image");
    assert.equal(requests, 0);
  }));

test("restoring the recent submission brings back prompt and references only, never a model", () =>
  withStore({ availableModelIds: KLING_AND_MAGNIFIC_OFF, mode: "image", model: "Nano Banana Pro",
    recentSubmission: { prompt: "again", referenceImages: [], referenceIds: [], referenceKinds: [], referenceLabels: [], referenceTags: [],
      referenceVideos: [], referenceAudios: [], videoNotes: [], audioNotes: [] } }, () => {
    useStore.getState().restoreRecentSubmission();
    assert.equal(useStore.getState().prompt, "again");
    assert.equal(useStore.getState().model, "Nano Banana Pro");
  }));
