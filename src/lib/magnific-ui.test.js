import assert from "node:assert/strict";
import test from "node:test";
import { MAGNIFIC_VIDEO_DEFAULTS, MAGNIFIC_VIDEO_MODELS, magnificVideoParamsForModel } from "./magnific-ui.js";
import { MODEL_REGISTRY } from "./model-registry.js";

test("video params carry only each model's documented fields", () => {
  const p = { ...MAGNIFIC_VIDEO_DEFAULTS };
  assert.deepEqual(magnificVideoParamsForModel("Magnific Video Creative", p), {
    model: "Magnific Video Creative", resolution: "2k", creativity: 0, sharpen: 0, smartGrain: 0, fpsBoost: false, flavor: "vivid", outputFormat: "h264" });
  assert.deepEqual(Object.keys(magnificVideoParamsForModel("Magnific Video Precision", p)).sort(),
    ["fpsBoost", "model", "outputFormat", "resolution", "sharpen", "smartGrain", "strength"]);
  assert.deepEqual(magnificVideoParamsForModel("Magnific Video Topaz", p), {
    model: "Magnific Video Topaz", resolution: "2k", enhancementModel: "starlight_precise_2_5", noise: 0 });
  assert.deepEqual(magnificVideoParamsForModel("Magnific Video Topaz", { ...p, targetFps: 30, frameInterpolation: "chronos" }), {
    model: "Magnific Video Topaz", resolution: "2k", enhancementModel: "starlight_precise_2_5", noise: 0, targetFps: 30, frameInterpolation: "chronos" });
  assert.throws(() => magnificVideoParamsForModel("Magnific Video Hyper", p));
});

test("every video upscaler is registered as a Magnific upscale model", () => {
  for (const name of MAGNIFIC_VIDEO_MODELS) {
    const entry = MODEL_REGISTRY.find((item) => item.name === name);
    assert.ok(entry, name);
    assert.equal(entry.kind, "upscale");
    assert.equal(entry.provider, "magnific");
    assert.equal(entry.capabilities.upscaleMedia, "video");
  }
});
