import test from "node:test";
import assert from "node:assert/strict";
import { CHAT_MODES, composerContext, composerTag, generationOptions, upscaleChoice } from "./agent-composer.js";
import { supportsAudio, supportsDraftMode, supportsVideoEditExtend } from "./config.js";
import { MAGNIFIC_VIDEO_DEFAULTS } from "./magnific-ui.js";
import { UNSORTED } from "./feed-scope.js";

const IMAGE_UPSCALE = { model: "Magnific Creative", filterNsfw: true, scaleFactor: "2x", prompt: "", optimizedFor: "standard",
  engine: "automatic", creativity: 0, hdr: 0, resemblance: 0, fractality: 0 };
const BASE = { activeProjectId: "p-1", activeFolderId: "f-1", batchCount: 2, upscalerMedia: "image", upscalerParams: IMAGE_UPSCALE,
  videoUpscalerParams: { ...MAGNIFIC_VIDEO_DEFAULTS }, upscalerImage: null, upscalerVideo: null };
const state = (fields) => ({ ...BASE, ...fields });

test("the chat offers Image, Video and Upscale", () => {
  assert.deepEqual(CHAT_MODES, ["image", "video", "upscale"]);
});

test("an Image message carries its model, settings and the folder new work lands in", () => {
  assert.deepEqual(composerContext(state({ mode: "image", model: "Nano Banana Pro", aspectRatio: "16:9", resolution: "2K" })), {
    mode: "image", model: "Nano Banana Pro", options: { aspectRatio: "16:9", resolution: "2K", count: 2 }, projectId: "p-1", folderId: "f-1",
  });
});

test("All in project and Unsorted send no folder, so work lands in the project's unsorted items", () => {
  for (const activeFolderId of [null, UNSORTED]) {
    const context = composerContext(state({ mode: "image", model: "Nano Banana Pro", aspectRatio: "1:1", resolution: "1K", activeFolderId }));
    assert.equal(context.projectId, "p-1");
    assert.equal("folderId" in context, false);
  }
  assert.equal("projectId" in composerContext(state({ mode: "image", model: "Nano Banana Pro", activeProjectId: null })), false);
});

test("a Video message passes only the settings its model takes", () => {
  const model = "Seedance 2.0";
  const options = generationOptions(state({ mode: "video", model, aspectRatio: "21:9", resolution: "1080p", duration: 5,
    generateAudio: true, draftMode: false, bitrateMode: "high", videoTaskMode: "generate" }));
  assert.equal(options.aspectRatio, "21:9");
  assert.equal(options.resolution, "1080p");
  assert.equal(options.durationSeconds, 5);
  assert.equal(options.generateAudio, supportsAudio(model) ? true : undefined);
  assert.equal(options.draft, supportsDraftMode(model) ? false : undefined);
  assert.equal(options.mode, supportsVideoEditExtend(model) ? "generate" : undefined);
  assert.equal("count" in options, false, "a video message makes one video unless the artist asks for more");
});

test("an edit sends an adaptive ratio and no duration, as the composer's own Generate does", () => {
  const model = "Seedance 2.0";
  if (!supportsVideoEditExtend(model)) return;
  const options = generationOptions(state({ mode: "video", model, aspectRatio: "21:9", resolution: "720p", duration: 5, videoTaskMode: "edit" }));
  assert.equal(options.aspectRatio, "adaptive");
  assert.equal(options.mode, "edit");
  assert.equal("durationSeconds" in options, false);
});

test("an Upscale message carries the upscaler, its parameters without the NSFW switch, and a stored source", () => {
  const context = composerContext(state({ mode: "upscale", upscalerImage: { url: "/api/media/u/a.png", name: "a.png" } }));
  assert.deepEqual(context, {
    mode: "upscale", model: "Magnific Creative", projectId: "p-1", folderId: "f-1",
    upscale: { media: "image", source: "/api/media/u/a.png", params: { scaleFactor: "2x", prompt: "", optimizedFor: "standard",
      engine: "automatic", creativity: 0, hdr: 0, resemblance: 0, fractality: 0 } },
  });
});

test("a video upscale uses the video upscaler's parameters, and an unstored source is left for the agent to ask about", () => {
  const choice = upscaleChoice(state({ mode: "upscale", upscalerMedia: "video", upscalerVideo: { url: "data:video/mp4;base64,AA" } }));
  assert.equal(choice.media, "video");
  assert.equal(choice.model, MAGNIFIC_VIDEO_DEFAULTS.model);
  assert.equal(choice.source, null);
  assert.equal("model" in choice.params, false);
  assert.equal(choice.params.resolution, MAGNIFIC_VIDEO_DEFAULTS.resolution);
});

test("other tabs' modes send no composer context", () => {
  assert.equal(composerContext(state({ mode: "depth" })), null);
});

test("a sent message is tagged with its mode and model", () => {
  assert.equal(composerTag({ mode: "video", model: "seedance-2-0", modelName: "Seedance 2.0" }), "Video · Seedance 2.0");
  assert.equal(composerTag({ mode: "image", model: "Nano Banana Pro" }), "Image · Nano Banana Pro");
  assert.equal(composerTag({ mode: "upscale", model: "Magnific Creative", upscale: { media: "image" } }), "Upscale image · Magnific Creative");
  assert.equal(composerTag({ mode: "upscale", media: "video", modelName: "Magnific Video Topaz" }), "Upscale video · Magnific Video Topaz");
  assert.equal(composerTag(null), null);
  assert.equal(composerTag({ mode: "depth" }), null);
});
