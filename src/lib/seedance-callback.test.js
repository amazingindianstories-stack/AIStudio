import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSeedanceCallbackUrl,
  callbackTokenMatches,
  extractProviderTaskId,
  MAX_PROVIDER_TASK_ID_LENGTH,
} from "./seedance-callback";
import { createSeedanceCallbackHandler } from "../app/api/webhooks/seedance/route";

function request(token, payload) {
  return {
    nextUrl: new URL(`https://app.example/api/webhooks/seedance${token == null ? "" : `?token=${encodeURIComponent(token)}`}`),
    json: async () => payload,
  };
}

async function withSecret(value, run) {
  const previous = process.env.SEEDANCE_CALLBACK_SECRET;
  if (value == null) delete process.env.SEEDANCE_CALLBACK_SECRET;
  else process.env.SEEDANCE_CALLBACK_SECRET = value;
  try { return await run(); }
  finally {
    if (previous == null) delete process.env.SEEDANCE_CALLBACK_SECRET;
    else process.env.SEEDANCE_CALLBACK_SECRET = previous;
  }
}

test("callback URL requires HTTPS and a secret and preserves query parameters", () => {
  assert.equal(buildSeedanceCallbackUrl("http://app.example/cb", "s"), undefined);
  assert.equal(buildSeedanceCallbackUrl("https://app.example/cb", ""), undefined);
  assert.equal(buildSeedanceCallbackUrl("not a url", "s"), undefined);
  assert.equal(buildSeedanceCallbackUrl("https://app.example/cb?a=1", "secret"), "https://app.example/cb?a=1&token=secret");
});

test("callback authentication rejects missing/wrong tokens and accepts the exact token", () => {
  assert.equal(callbackTokenMatches(undefined, "secret"), false);
  assert.equal(callbackTokenMatches("wrong", "secret"), false);
  assert.equal(callbackTokenMatches("secret", "secret"), true);
});

test("task id extraction supports documented shapes and rejects malformed or oversized ids", () => {
  assert.equal(extractProviderTaskId({ id: "task-1" }), "task-1");
  assert.equal(extractProviderTaskId({ task_id: "task_2" }), "task_2");
  assert.equal(extractProviderTaskId({ data: { id: "task:3" } }), "task:3");
  assert.equal(extractProviderTaskId({ id: "bad/id" }), undefined);
  assert.equal(extractProviderTaskId({ id: "x".repeat(MAX_PROVIDER_TASK_ID_LENGTH + 1) }), undefined);
});

test("handler fails closed when unconfigured or unauthorized", async () => {
  const handler = createSeedanceCallbackHandler();
  await withSecret(undefined, async () => assert.equal((await handler(request("x", { id: "t" }))).status, 503));
  await withSecret("secret", async () => assert.equal((await handler(request("wrong", { id: "t" }))).status, 401));
});

test("handler returns 400 for malformed bodies and 202 for task-id persistence races", async () => {
  const handler = createSeedanceCallbackHandler({ getItemByTaskId: async () => undefined });
  await withSecret("secret", async () => {
    assert.equal((await handler(request("secret", {}))).status, 400);
    assert.equal((await handler(request("secret", { id: "task-1" }))).status, 202);
  });
});

test("duplicate terminal callbacks only timestamp the row", async () => {
  let advances = 0;
  let marked = 0;
  const terminal = { id: "g", kind: "video", status: "succeeded", taskId: "task-1" };
  const handler = createSeedanceCallbackHandler({
    getItemByTaskId: async () => terminal,
    markCallbackReceived: async () => { marked += 1; return terminal; },
    advanceVideoStatus: async () => { advances += 1; },
  });
  await withSecret("secret", async () => {
    const response = await handler(request("secret", { id: "task-1", status: "succeeded" }));
    assert.equal(response.status, 200);
  });
  assert.equal(marked, 1);
  assert.equal(advances, 0);
});

test("best-of candidate callback reuses its payload and fetches other candidates", async () => {
  const calls = [];
  const running = { id: "g", kind: "video", status: "running", taskId: "primary", candidateTaskIds: ["candidate"], updatedAt: 1 };
  const handler = createSeedanceCallbackHandler({
    getItemByTaskId: async () => running,
    markCallbackReceived: async () => running,
    getVideoTask: async (id) => { calls.push(id); return { status: "running" }; },
    advanceVideoStatus: async (_item, options) => {
      assert.equal((await options.dependencies.getVideoTask("candidate")).status, "succeeded");
      await options.dependencies.getVideoTask("primary");
      return { kind: "pending" };
    },
  });
  await withSecret("secret", async () => {
    const response = await handler(request("secret", { id: "candidate", status: "succeeded", content: { video_url: "https://media.example/v.mp4" } }));
    assert.equal(response.status, 200);
  });
  assert.deepEqual(calls, ["primary"]);
});
