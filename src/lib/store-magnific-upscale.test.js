import assert from "node:assert/strict";
import test from "node:test";
import { useStore, isMagnificUpscale } from "./store";

const VIDEO_ROW = {
  id: "v-1", kind: "video", status: "succeeded", model: "Magnific Video Precision", prompt: "Magnific Video Precision (4k)",
  resolution: "4k", aspectRatio: "16:9", url: "/api/media/generations/v-1/out.mp4",
  referenceVideos: ["/api/media/generations/source/draft.mov"], projectId: "p-1", folderId: "f-1",
  upscaleParams: { model: "Magnific Video Precision", resolution: "4k", sharpen: 12, smartGrain: 4, strength: 80, fpsBoost: true, outputFormat: "prores_422_hq" },
};
const IMAGE_ROW = {
  id: "i-1", kind: "image", status: "succeeded", model: "Magnific Creative", prompt: "Magnific Creative (4x)",
  resolution: "4x", aspectRatio: "4:3", url: "/api/media/generations/i-1/out.png",
  referenceImages: ["/api/media/references/i-1-0.png"], projectId: "p-1",
  upscaleParams: { model: "Magnific Creative", filterNsfw: false, scaleFactor: "4x", prompt: "film grain", optimizedFor: "films_n_photography",
    engine: "magnific_sharpy", creativity: 3, hdr: 1, resemblance: 2, fractality: 0 },
};

function withStore(patch, run) {
  const previous = useStore.getState();
  const fetchBefore = globalThis.fetch;
  useStore.setState({ generating: false, items: [VIDEO_ROW, IMAGE_ROW], threadItems: [], pendingItems: [], mode: "video", model: "Seedance 2.5", ...patch });
  return Promise.resolve(run()).finally(() => {
    globalThis.fetch = fetchBefore;
    useStore.setState(previous, true);
  });
}

test("Magnific rows are recognised as upscales; other rows are not", () => {
  assert.equal(isMagnificUpscale(VIDEO_ROW), true);
  assert.equal(isMagnificUpscale(IMAGE_ROW), true);
  assert.equal(isMagnificUpscale({ model: "Seedance 2.5" }), false);
});

test("Edit & retry on a Magnific video reopens the video upscaler with its source, model and resolution", () =>
  withStore({}, async () => {
    assert.deepEqual(await useStore.getState().cloneToComposer("v-1"), { ok: true });
    const s = useStore.getState();
    assert.equal(s.mode, "upscale");
    assert.equal(s.upscalerMedia, "video");
    assert.equal(s.upscalerVideo.url, "/api/media/generations/source/draft.mov");
    assert.equal(s.videoUpscalerParams.model, "Magnific Video Precision");
    assert.equal(s.videoUpscalerParams.resolution, "4k");
    assert.equal(s.videoUpscalerParams.strength, 80);
    assert.equal(s.videoUpscalerParams.outputFormat, "prores_422_hq");
    assert.equal(s.videoUpscalerParams.fpsBoost, true);
    assert.equal(s.model, "Seedance 2.5", "the video composer's own model is untouched");
  }));

test("Edit on a Magnific image reopens the image upscaler with its stored source and scale", () =>
  withStore({}, async () => {
    assert.deepEqual(useStore.getState().editInComposer("i-1"), { ok: true });
    const s = useStore.getState();
    assert.equal(s.mode, "upscale");
    assert.equal(s.upscalerMedia, "image");
    assert.equal(s.upscalerImage.url, "/api/media/references/i-1-0.png");
    assert.equal(s.upscalerParams.model, "Magnific Creative");
    assert.equal(s.upscalerParams.scaleFactor, "4x");
    assert.equal(s.upscalerParams.prompt, "film grain");
    assert.equal(s.upscalerParams.engine, "magnific_sharpy");
  }));

test("Regenerate on a Magnific video resubmits the original job exactly and leaves the composer alone", () =>
  withStore({ mode: "image", upscalerVideo: { url: "/api/media/uploads/video-reference/in-progress.mp4" } }, async () => {
    const calls = [];
    globalThis.fetch = async (url, options = {}) => {
      calls.push({ url: String(url), body: options.body ? JSON.parse(options.body) : null });
      if (String(url).includes("/api/generate/upscale")) {
        return new Response(JSON.stringify({ ...VIDEO_ROW, id: "v-2", status: "queued", url: undefined }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    };
    assert.deepEqual(await useStore.getState().regenerate("v-1"), { ok: true });
    const posts = calls.filter((call) => call.url.includes("/api/generate/"));
    assert.equal(posts.length, 1);
    assert.match(posts[0].url, /\/api\/generate\/upscale$/);
    assert.equal(posts[0].body.video, "/api/media/generations/source/draft.mov");
    assert.equal(posts[0].body.model, "Magnific Video Precision");
    assert.deepEqual(posts[0].body.params, VIDEO_ROW.upscaleParams);
    assert.equal(posts[0].body.projectId, "p-1");
    assert.equal(posts[0].body.folderId, "f-1");
    const s = useStore.getState();
    assert.equal(s.mode, "image", "the composer mode is untouched");
    assert.equal(s.upscalerVideo.url, "/api/media/uploads/video-reference/in-progress.mp4", "an in-progress source is kept");
    assert.equal(s.generating, false);
  }));

test("Regenerate refuses a Magnific row without its stored parameters instead of guessing", () =>
  withStore({ items: [{ ...VIDEO_ROW, upscaleParams: undefined }] }, async () => {
    let posted = false;
    globalThis.fetch = async () => { posted = true; return new Response("{}", { status: 200 }); };
    const result = await useStore.getState().regenerate("v-1");
    assert.equal(result.ok, false);
    assert.equal(posted, false);
  }));

test("a Magnific row without its stored source is refused instead of opening an empty upscaler", () =>
  withStore({ items: [{ ...VIDEO_ROW, referenceVideos: [] }] }, async () => {
    const result = await useStore.getState().cloneToComposer("v-1");
    assert.equal(result.ok, false);
    assert.equal(useStore.getState().mode, "video");
  }));
