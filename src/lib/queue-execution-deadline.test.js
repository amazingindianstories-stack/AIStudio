import { test } from "vitest";
import assert from "node:assert/strict";
import {
  QueueExecutionDeadlineError,
  abortableDelay,
  settleQueueExecution,
  withQueueExecutionDeadline,
} from "@/lib/queue-execution-deadline";

test("fast queue work resolves normally", async () => {
  assert.equal(await withQueueExecutionDeadline(async () => "ok", 100), "ok");
});

test("deadline aborts work with its deterministic reason", async () => {
  let observed;
  await assert.rejects(
    withQueueExecutionDeadline(async (signal) => {
      observed = signal;
      await abortableDelay(1_000, signal);
    }, 10),
    (error) => error instanceof QueueExecutionDeadlineError && /1-second/.test(error.message)
  );
  assert.equal(observed.aborted, true);
  assert.ok(observed.reason instanceof QueueExecutionDeadlineError);
});

test("settlement calls success once for fast work", async () => {
  let successes = 0;
  let failures = 0;
  const result = await settleQueueExecution({
    work: async () => "done",
    onSuccess: async (value) => (++successes, value),
    onFailure: async () => ++failures,
    timeoutMs: 100,
  });
  assert.equal(result, "done");
  assert.equal(successes, 1);
  assert.equal(failures, 0);
});

test("a success persistence error is not rewritten as a generation failure", async () => {
  let failures = 0;
  await assert.rejects(
    settleQueueExecution({
      work: async () => "done",
      onSuccess: async () => { throw new Error("database unavailable"); },
      onFailure: async () => ++failures,
      timeoutMs: 100,
    }),
    /database unavailable/
  );
  assert.equal(failures, 0);
});

test("late unabortable work cannot persist success after failure", async () => {
  let release;
  const late = new Promise((resolve) => { release = resolve; });
  let successes = 0;
  let failures = 0;
  const settled = settleQueueExecution({
    work: async () => late,
    onSuccess: async () => ++successes,
    onFailure: async (error) => {
      failures += 1;
      assert.ok(error instanceof QueueExecutionDeadlineError);
      return "failed";
    },
    timeoutMs: 10,
  });
  assert.equal(await settled, "failed");
  release("too late");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(failures, 1);
  assert.equal(successes, 0);
});
