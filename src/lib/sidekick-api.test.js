import assert from "node:assert/strict";
import test from "node:test";
import { waitForJob } from "./sidekick-api.js";

test("waitForJob survives one failed poll and resolves with the finished job", async () => {
  let calls = 0;
  const fetchJob = async () => {
    calls += 1;
    if (calls === 1) throw new TypeError("Failed to fetch");
    return { id: "j", status: "succeeded" };
  };
  const job = await waitForJob("b", "j", { fetchJob, interval: () => 0 });
  assert.equal(job.status, "succeeded");
  assert.equal(calls, 2);
});

test("waitForJob gives up after maxFailures consecutive failures", async () => {
  let calls = 0;
  const fetchJob = async () => { calls += 1; throw new TypeError("Failed to fetch"); };
  await assert.rejects(waitForJob("b", "j", { fetchJob, interval: () => 0, maxFailures: 3 }), { message: "Failed to fetch" });
  assert.equal(calls, 3);
});

test("waitForJob does not retry a definite refusal", async () => {
  for (const status of [401, 403, 404]) {
    let calls = 0;
    const fetchJob = async () => { calls += 1; throw Object.assign(new Error("no"), { status }); };
    await assert.rejects(waitForJob("b", "j", { fetchJob, interval: () => 0 }));
    assert.equal(calls, 1);
  }
});

test("waitForJob stops when aborted", async () => {
  await assert.rejects(waitForJob("b", "j", { fetchJob: async () => ({ status: "running" }), interval: () => 0, signal: { aborted: true } }), { name: "AbortError" });
});
