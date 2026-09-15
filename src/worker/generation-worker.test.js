import assert from "node:assert/strict";
import test from "node:test";
import { boundedRetryDelay, runCoordinatorOnce } from "./generation-worker";

const queued = { id: "g1", kind: "video", status: "queued", updatedAt: 1, pollAttempts: 0 };

test("only one concurrent worker claim can submit a job", async () => {
  let owner;
  let submissions = 0;
  const claim = async (_id, candidate) => owner ? undefined : (owner = candidate, { ...queued, workerLeaseId: candidate });
  const options = {
    select: async () => [queued], claim, release: async () => {}, secret: "worker-secret", baseUrl: "https://app.example",
    fetchImpl: async () => { submissions += 1; return { ok: true, json: async () => ({ id: "g1", status: "running" }) }; },
  };
  await Promise.all([runCoordinatorOnce(options), runCoordinatorOnce(options)]);
  assert.equal(submissions, 1);
});

test("queue notAdmitted timing is scheduled instead of resubmitted immediately", async () => {
  let delay;
  const result = await runCoordinatorOnce({
    select: async () => [queued], claim: async () => queued, release: async () => {},
    schedule: async (_item, options) => { delay = options.delayMs; },
    secret: "worker-secret", baseUrl: "https://app.example",
    fetchImpl: async () => ({ ok: true, json: async () => ({ notAdmitted: true, retryAfterMs: 42_000 }) }),
  });
  assert.equal(delay, 42_000);
  assert.equal(result.deferred, 1);
  assert.equal(result.submitted, 0);
});

test("selection/database disconnect is contained for the next loop", async () => {
  const logs = [];
  const result = await runCoordinatorOnce({ select: async () => { throw new Error("database unavailable"); }, logger: { error: (entry) => logs.push(entry) } });
  assert.equal(result.errors, 1);
  assert.equal(logs[0].event, "generation_worker_select_error");
});

test("provider/auth failures back off and logs never contain the worker secret", async () => {
  const logs = [];
  let delay;
  await runCoordinatorOnce({
    select: async () => [queued], claim: async () => queued, release: async () => {},
    schedule: async (_item, options) => { delay = options.delayMs; },
    secret: "do-not-log-this", baseUrl: "https://app.example",
    fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }),
    logger: { error: (entry) => logs.push(entry) },
  });
  assert.ok(delay >= 10_000);
  assert.equal(JSON.stringify(logs).includes("do-not-log-this"), false);
  assert.equal(boundedRetryDelay(1), 5_000);
  assert.equal(boundedRetryDelay(999_999), 60_000);
});
