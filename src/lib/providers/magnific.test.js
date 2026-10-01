import test from "node:test";
import assert from "node:assert/strict";
import {
  buildMagnificPayload,
  resolveMagnificVariant,
  submitMagnificUpscale,
  getMagnificUpscaleStatus,
  magnificParamsForModel,
} from "./magnific.js";

const DUMMY_IMAGE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

test("resolveMagnificVariant identifies models correctly", () => {
  assert.equal(resolveMagnificVariant("Magnific Creative"), "creative");
  assert.equal(resolveMagnificVariant("Magnific Precision V1"), "precision-v1");
  assert.equal(resolveMagnificVariant("Magnific Precision V2"), "precision-v2");
  assert.throws(() => resolveMagnificVariant("Upscaler Precision"), /Unsupported/);
});

test("model request parameters exclude controls for other variants", () => {
  const all = { filterNsfw: false, scaleFactor: "2x", prompt: "p", optimizedFor: "standard", engine: "automatic", creativity: 0, hdr: 0, resemblance: 0, fractality: 0, flavor: "photo", sharpen: 7, smartGrain: 7, ultraDetail: 30 };
  assert.deepEqual(Object.keys(magnificParamsForModel("Magnific Precision V1", all)).sort(), ["filterNsfw", "model", "sharpen", "smartGrain", "ultraDetail"]);
  assert.equal(magnificParamsForModel("Magnific Creative", all).flavor, undefined);
});

test("buildMagnificPayload shapes Upscaler Creative payload", () => {
  const { endpoint, body } = buildMagnificPayload("creative", {
    image: DUMMY_IMAGE,
    params: {
      scaleFactor: "4x",
      prompt: "Ultra detailed cinematic render",
      optimizedFor: "films_n_photography",
      engine: "magnific_illusio",
      creativity: 3,
      hdr: 2,
      resemblance: -1,
      fractality: 1,
      filterNsfw: true,
    },
  });

  assert.equal(endpoint, "/v1/ai/image-upscaler");
  assert.equal(body.image, DUMMY_IMAGE);
  assert.equal(body.scale_factor, "4x");
  assert.equal(body.prompt, "Ultra detailed cinematic render");
  assert.equal(body.optimized_for, "films_n_photography");
  assert.equal(body.engine, "magnific_illusio");
  assert.equal(body.creativity, 3);
  assert.equal(body.hdr, 2);
  assert.equal(body.resemblance, -1);
  assert.equal(body.fractality, 1);
  assert.equal(body.filter_nsfw, true);
});

test("buildMagnificPayload shapes Upscaler Precision V2 payload", () => {
  const { endpoint, body } = buildMagnificPayload("precision-v2", {
    image: DUMMY_IMAGE,
    params: {
      scaleFactor: "8x",
      flavor: "sublime",
      sharpen: 45,
      smartGrain: 12,
      ultraDetail: 60,
      filterNsfw: false,
    },
  });

  assert.equal(endpoint, "/v1/ai/image-upscaler-precision-v2");
  assert.equal(body.image, DUMMY_IMAGE);
  assert.equal(body.scale_factor, 8);
  assert.equal(body.flavor, "sublime");
  assert.equal(body.sharpen, 45);
  assert.equal(body.smart_grain, 12);
  assert.equal(body.ultra_detail, 60);
  assert.equal(body.filter_nsfw, false);
});

test("buildMagnificPayload shapes Upscaler Precision V1 payload", () => {
  const { endpoint, body } = buildMagnificPayload("precision-v1", {
    image: DUMMY_IMAGE,
    params: {
      sharpen: 80,
      smartGrain: 15,
      ultraDetail: 40,
      filterNsfw: true,
    },
  });

  assert.equal(endpoint, "/v1/ai/image-upscaler-precision");
  assert.equal(body.image, DUMMY_IMAGE);
  assert.equal(body.sharpen, 80);
  assert.equal(body.smart_grain, 15);
  assert.equal(body.ultra_detail, 40);
  assert.equal(body.filter_nsfw, true);
});

test("submitMagnificUpscale handles successful submission", async () => {
  const mockFetch = async (url, options) => {
    assert.match(url, /\/v1\/ai\/image-upscaler-precision-v2$/);
    assert.equal(options.headers["x-magnific-api-key"], "test-key");
    const parsed = JSON.parse(options.body);
    assert.equal(parsed.scale_factor, 2);

    return {
      ok: true,
      json: async () => ({
        data: {
          task_id: "mock-task-123",
          status: "CREATED",
        },
      }),
    };
  };

  const res = await submitMagnificUpscale({
    model: "Magnific Precision V2",
    image: DUMMY_IMAGE,
    params: { scaleFactor: "2x" },
    apiKey: "test-key",
    fetchImpl: mockFetch,
  });

  assert.equal(res.taskId, "mock-task-123");
  assert.equal(res.status, "CREATED");
  assert.equal(res.variant, "precision-v2");
});

test("submitMagnificUpscale throws on API error", async () => {
  const mockFetch = async () => ({
    ok: false,
    status: 400,
    json: async () => ({
      message: "Image validation failed",
      invalid_params: [{ field: "body.image", reason: "Invalid format" }],
    }),
  });

  await assert.rejects(
    submitMagnificUpscale({
      model: "Magnific Creative",
      image: DUMMY_IMAGE,
      apiKey: "test-key",
      fetchImpl: mockFetch,
    }),
    /body\.image: Invalid format/
  );
});

test("getMagnificUpscaleStatus returns completed output URL", async () => {
  const mockFetch = async (url) => {
    assert.match(url, /\/v1\/ai\/image-upscaler\/mock-task-456$/);
    return {
      ok: true,
      json: async () => ({
        data: {
          task_id: "mock-task-456",
          status: "COMPLETED",
          generated: ["https://cdn.magnific.com/output.png"],
        },
      }),
    };
  };

  const res = await getMagnificUpscaleStatus({
    model: "Magnific Creative",
    taskId: "mock-task-456",
    apiKey: "test-key",
    fetchImpl: mockFetch,
  });

  assert.equal(res.status, "succeeded");
  assert.equal(res.generatedUrl, "https://cdn.magnific.com/output.png");
});

test("getMagnificUpscaleStatus returns running on IN_PROGRESS", async () => {
  const mockFetch = async () => ({
    ok: true,
    json: async () => ({
      data: {
        task_id: "mock-task-789",
        status: "IN_PROGRESS",
      },
    }),
  });

  const res = await getMagnificUpscaleStatus({
    model: "Magnific Precision V1",
    taskId: "mock-task-789",
    apiKey: "test-key",
    fetchImpl: mockFetch,
  });

  assert.equal(res.status, "running");
});
