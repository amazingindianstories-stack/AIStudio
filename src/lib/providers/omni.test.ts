/**
 * Unit tests for the pure/network-stubbed helpers in src/lib/providers/omni.ts,
 * derived from .council/omni-video/design.md Phase 2 and spec.md AC3/AC6/AC7,
 * independently of the implementation. createOmniVideoTask/getOmniVideoStatus
 * (the real network functions) are NOT exercised here — those are covered by
 * scripts/probe-omni.ts and the authorized live generation test. Run:
 *   npx tsx --test src/lib/providers/omni.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  isOmniModel,
  assertGoogleHost,
  buildOmniEndpoint,
  buildOmniPayload,
  mapOmniStatus,
  extractOmniVideo,
} from "./omni";

test("isOmniModel: matches 'Gemini Omni Flash' case-insensitively", () => {
  assert.ok(isOmniModel("Gemini Omni Flash"));
  assert.ok(isOmniModel("gemini omni flash"));
  assert.ok(!isOmniModel("Higgsfield Seedance 2.0"));
});

test("assertGoogleHost: allows googleapis.com and subdomains", () => {
  assert.doesNotThrow(() => assertGoogleHost("https://generativelanguage.googleapis.com/v1beta/files/x"));
  assert.doesNotThrow(() => assertGoogleHost("https://googleapis.com/x"));
});

test("assertGoogleHost: throws on a non-Google host", () => {
  assert.throws(() => assertGoogleHost("https://example.com/video.mp4"), /Refusing to attach Omni credentials/);
});

test("buildOmniEndpoint: genlang path needs no project", () => {
  assert.equal(
    buildOmniEndpoint({ vertex: false }),
    "https://generativelanguage.googleapis.com/v1beta/interactions"
  );
});

test("buildOmniEndpoint: vertex path requires a project id", () => {
  assert.throws(() => buildOmniEndpoint({ vertex: true }), /requires a GCP project/);
});

test("buildOmniEndpoint: vertex path builds the projects/.../locations/global/interactions URL", () => {
  assert.equal(
    buildOmniEndpoint({ vertex: true, project: "my-proj" }),
    "https://aiplatform.googleapis.com/v1beta1/projects/my-proj/locations/global/interactions"
  );
});

test("buildOmniPayload: throws on an unsupported aspect ratio before any network call", () => {
  assert.throws(() => buildOmniPayload([], "1:1", 4), /only supports 16:9\/9:16/);
});

test("buildOmniPayload: accepts 16:9 and 9:16, sets response_format fields (no task/delivery — not real API fields)", () => {
  const payload = buildOmniPayload([], "16:9", 4) as any;
  assert.equal(payload.response_format.type, "video");
  assert.equal(payload.response_format.aspect_ratio, "16:9");
  assert.equal(payload.background, true);
  assert.equal(payload.task, undefined);
  assert.equal(payload.delivery, undefined);
});

test("buildOmniPayload: formats duration as a protobuf-Duration string (e.g. 4 -> \"4s\")", () => {
  const payload = buildOmniPayload([], "16:9", 6) as any;
  assert.equal(payload.response_format.duration, "6s");
});

test("mapOmniStatus: completed -> succeeded", () => {
  assert.equal(mapOmniStatus("completed"), "succeeded");
});

test("mapOmniStatus: in_progress -> running", () => {
  assert.equal(mapOmniStatus("in_progress"), "running");
});

for (const s of ["failed", "cancelled", "incomplete", "budget_exceeded", "requires_action"]) {
  test(`mapOmniStatus: ${s} -> failed`, () => {
    assert.equal(mapOmniStatus(s), "failed");
  });
}

test("mapOmniStatus: an unrecognized status falls back to running (route timeout is the backstop)", () => {
  assert.equal(mapOmniStatus("some_future_status"), "running");
  assert.equal(mapOmniStatus(undefined), "running");
});

test("extractOmniVideo: reads inline base64 from steps[].content (live-measured shape — steps carry `content` directly, not under a model_output wrapper)", async () => {
  const json = {
    steps: [
      { type: "thought", signature: "..." },
      { type: "model_output", content: [{ type: "video", mime_type: "video/mp4", data: "QUJD" }] },
    ],
  };
  const result = await extractOmniVideo(json);
  assert.equal(result.base64, "QUJD");
  assert.equal(result.mimeType, "video/mp4");
});

test("extractOmniVideo: throws loudly when completed but no video data or uri present", async () => {
  await assert.rejects(() => extractOmniVideo({ steps: [] }), /returned no video/);
});

test("extractOmniVideo: downloads output_video.uri on a Google host, attaching the given api key", async () => {
  const originalFetch = global.fetch;
  let calledUrl: string | undefined;
  let calledHeaders: Record<string, string> | undefined;
  global.fetch = (async (url: string, init?: any) => {
    calledUrl = url;
    calledHeaders = init?.headers;
    return {
      ok: true,
      headers: new Map([["content-type", "video/mp4"]]) as any,
      arrayBuffer: async () => new TextEncoder().encode("video-bytes").buffer,
    } as any;
  }) as any;
  try {
    const json = { output_video: { uri: "https://generativelanguage.googleapis.com/v1beta/files/x:download" } };
    const result = await extractOmniVideo(json, { apiKey: "test-key" });
    assert.equal(calledUrl, "https://generativelanguage.googleapis.com/v1beta/files/x:download");
    assert.equal(calledHeaders?.["x-goog-api-key"], "test-key");
    assert.equal(result.mimeType, "video/mp4");
  } finally {
    global.fetch = originalFetch;
  }
});

test("extractOmniVideo: refuses to fetch a non-Google output_video.uri — zero fetch calls", async () => {
  const originalFetch = global.fetch;
  let fetchCalls = 0;
  global.fetch = (async () => {
    fetchCalls += 1;
    throw new Error("fetch should not have been called");
  }) as any;
  try {
    const json = { output_video: { uri: "https://example.com/video.mp4" } };
    await assert.rejects(() => extractOmniVideo(json), /Refusing to attach Omni credentials/);
    assert.equal(fetchCalls, 0);
  } finally {
    global.fetch = originalFetch;
  }
});
