import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { inspectUpscaleImage, validateUpscaleRequest, validateUpscaleSourceReference } from "./magnific-validation";

const creative = { model: "Magnific Creative", image: "data:image/png;base64,eA==", params: { model: "Magnific Creative", scaleFactor: "2x", optimizedFor: "standard", engine: "automatic", creativity: 0, hdr: 0, resemblance: 0, fractality: 0, filterNsfw: true, prompt: "" } };

test("upscale validation allowlists models and model-specific parameters", () => {
  assert.equal(validateUpscaleRequest(creative).model, creative.model);
  assert.throws(() => validateUpscaleRequest({ ...creative, model: "Other" }), /Unsupported/);
  assert.throws(() => validateUpscaleRequest({ ...creative, params: { ...creative.params, flavor: "photo" } }), /not supported/);
  assert.throws(() => validateUpscaleRequest({ ...creative, params: { ...creative.params, prompt: "x".repeat(2001) } }), /2000/);
});

test("upscale source only accepts data URIs and application media URLs", () => {
  assert.doesNotThrow(() => validateUpscaleSourceReference(creative.image, "http://localhost:3000"));
  assert.doesNotThrow(() => validateUpscaleSourceReference("/api/media/references/example.png", "http://localhost:3000"));
  assert.throws(() => validateUpscaleSourceReference("http://169.254.169.254/latest", "http://localhost:3000"), /uploaded/);
  assert.throws(() => validateUpscaleSourceReference("https://example.com/a.png", "http://localhost:3000"), /uploaded/);
});

test("image inspection detects MIME mismatches", async () => {
  const buffer = await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } }).png().toBuffer();
  const data = buffer.toString("base64");
  assert.equal((await inspectUpscaleImage(data, "image/png")).meta.width, 2);
  await assert.rejects(inspectUpscaleImage(data, "image/jpeg"), /does not match/);
});
