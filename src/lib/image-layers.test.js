import test from "node:test";
import assert from "node:assert/strict";
import { imageLayerLimitsForModel, imageLayersRequest } from "./config.js";

test("only Seedream 5.5 offers layer decomposition", () => {
  assert.deepEqual(imageLayerLimitsForModel("Seedream 5.5"), { minImages: 2, maxImages: 100, defaultImages: 30 });
  assert.equal(imageLayerLimitsForModel("Seedream 5.0 Pro"), null);
});

test("the layer request is clamped, and off or unsupported sends nothing", () => {
  const on = { enabled: true, maxImages: 15, textRecognition: true };
  assert.deepEqual(imageLayersRequest("Seedream 5.5", on), { maxImages: 15, textRecognition: true });
  assert.equal(imageLayersRequest("Seedream 5.5", { ...on, maxImages: 500 }).maxImages, 100);
  assert.equal(imageLayersRequest("Seedream 5.5", { ...on, maxImages: 1 }).maxImages, 2);
  assert.equal(imageLayersRequest("Seedream 5.5", { ...on, maxImages: "" }).maxImages, 30);
  assert.equal(imageLayersRequest("Seedream 5.5", { ...on, enabled: false }), null);
  assert.equal(imageLayersRequest("Seedream 5.0 Pro", on), null);
});
