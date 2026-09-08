import assert from "node:assert/strict";
import { test } from "vitest";
import { advanceVideoStatus } from "./video-status-advancement";

function item(overrides = {}) {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    kind: "video", status: "running", taskId: "provider-task", model: "Seedance 2.0",
    prompt: "private prompt", aspectRatio: "16:9", costCents: 10, costBasis: "estimated",
    createdAt: 1, updatedAt: 100, pollErrorCount: 0, ...overrides,
  };
}

function dependencies(overrides = {}) {
  return {
    now: () => 500,
    isMock: () => false,
    isOmniModel: () => false,
    isHiggsfieldModel: () => false,
    getVideoTask: async () => ({ status: "running" }),
    clearVideoPollErrors: async (_expected) => ({ ...item(), pollErrorCount: 0 }),
    compareAndSetVideoOutcome: async (_expected, updates) => ({ ...item(), ...updates }),
    recordVideoPollError: async () => ({ pollErrorCount: 2, lastPollErrorAt: 500 }),
    saveFromUrlWithMetadata: async (url) => ({ url, aspectRatio: "16:9" }),
    saveBase64WithMetadata: async () => ({ url: "/saved.mp4", aspectRatio: "16:9" }),
    getModelDefinition: () => undefined,
    emitGenerationEvent: () => {},
    ...overrides,
  };
}

test("pending provider response only clears poll health", async () => {
  let cleared;
  let terminalWrites = 0;
  const outcome = await advanceVideoStatus(item({ pollErrorCount: 4 }), { dependencies: dependencies({
    clearVideoPollErrors: async (expected) => {
      cleared = expected;
      return item({ pollErrorCount: 0, lastPollErrorAt: undefined });
    },
    compareAndSetVideoOutcome: async () => { terminalWrites += 1; },
  }) });
  assert.equal(outcome.kind, "pending");
  assert.equal(terminalWrites, 0);
  assert.equal(cleared.updatedAt, 100);
});

test("transport, authentication, and timeout-like errors stay non-terminal", async () => {
  let terminalWrites = 0;
  let recorded;
  const outcome = await advanceVideoStatus(item(), { dependencies: dependencies({
    getVideoTask: async () => { throw new Error("401 provider credential rejected"); },
    compareAndSetVideoOutcome: async () => { terminalWrites += 1; },
    recordVideoPollError: async (expected, at) => {
      recorded = { expected, at };
      return { pollErrorCount: 3, lastPollErrorAt: at };
    },
  }) });
  assert.equal(outcome.kind, "poll_error");
  assert.equal(outcome.pollErrorCount, 3);
  assert.equal(outcome.retryAfterMs, 16_000);
  assert.equal(terminalWrites, 0);
  assert.equal(recorded.expected.updatedAt, 100);
  assert.equal(JSON.stringify(outcome).includes("credential"), false);
});

test("conclusive provider failure persists through compare-and-set", async () => {
  let updates;
  const outcome = await advanceVideoStatus(item(), { dependencies: dependencies({
    getVideoTask: async () => ({ status: "failed", error: "provider rejected generation" }),
    compareAndSetVideoOutcome: async (_expected, next) => {
      updates = next;
      return item(next);
    },
  }) });
  assert.equal(outcome.kind, "failed");
  assert.equal(updates.status, "failed");
  assert.equal(updates.updatedAt, 500);
});

test("compare-and-set race never overwrites the winner", async () => {
  let writes = 0;
  const deps = dependencies({
    getVideoTask: async () => ({ status: "succeeded", videoUrl: "https://provider/video.mp4" }),
    compareAndSetVideoOutcome: async (_expected, updates) => {
      writes += 1;
      return writes === 1 ? item(updates) : undefined;
    },
  });
  const outcomes = await Promise.all([
    advanceVideoStatus(item(), { source: "browser", dependencies: deps }),
    advanceVideoStatus(item(), { source: "cron", dependencies: deps }),
  ]);
  assert.deepEqual(outcomes.map((outcome) => outcome.kind).sort(), ["raced", "succeeded"]);
});

test("completed Omni inline payload is saved before terminal persistence", async () => {
  let savedPayload;
  let persisted;
  const outcome = await advanceVideoStatus(item({ model: "Omni" }), { dependencies: dependencies({
    isOmniModel: () => true,
    getOmniVideoStatus: async () => ({
      status: "succeeded", videoBase64: "cGF5bG9hZA==", mimeType: "video/mp4",
    }),
    saveBase64WithMetadata: async (payload) => {
      savedPayload = payload;
      return { url: "/durable.mp4", aspectRatio: "16:9" };
    },
    compareAndSetVideoOutcome: async (_expected, updates) => {
      persisted = updates;
      return item({ model: "Omni", ...updates });
    },
  }) });
  assert.equal(outcome.kind, "succeeded");
  assert.equal(savedPayload, "cGF5bG9hZA==");
  assert.equal(persisted.url, "/durable.mp4");
});

test("a task-less row is never submitted or terminally failed", async () => {
  let providerCalls = 0;
  const outcome = await advanceVideoStatus(item({ taskId: undefined }), { dependencies: dependencies({
    getVideoTask: async () => { providerCalls += 1; },
  }) });
  assert.equal(outcome.kind, "pending");
  assert.equal(providerCalls, 0);
});

test("best-of terminal outcome clears candidate task metadata", async () => {
  let persisted;
  const outcome = await advanceVideoStatus(item({
    candidateTaskIds: ["candidate-two"], referenceImages: [],
  }), { dependencies: dependencies({
    getVideoTask: async (taskId) => ({ status: "succeeded", videoUrl: `https://provider/${taskId}.mp4` }),
    compareAndSetVideoOutcome: async (_expected, updates) => {
      persisted = updates;
      return item(updates);
    },
  }) });
  assert.equal(outcome.kind, "succeeded");
  assert.equal(persisted.candidateTaskIds, null);
});
