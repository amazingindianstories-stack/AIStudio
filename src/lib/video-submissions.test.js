import { test } from "vitest";
import assert from "node:assert/strict";

import { submitVideoCandidates } from "@/lib/video-submissions";

test("video best-of retains all accepted task ids and offsets seeds", async () => {
  const seen = [];
  const result = await submitVideoCandidates({
    count: 3,
    totalCostCents: 90,
    seed: 40,
    submit: async (seed, index) => {
      seen.push([seed, index]);
      return `task-${index}`;
    },
  });
  assert.deepEqual(seen, [[40, 0], [41, 1], [42, 2]]);
  assert.deepEqual(result, {
    acceptedTaskIds: ["task-0", "task-1", "task-2"],
    rejectedCount: 0,
    costCents: 90,
  });
});

test("video best-of keeps partial successes and bills only accepted candidates", async () => {
  const result = await submitVideoCandidates({
    count: 3,
    totalCostCents: 90,
    submit: async (_seed, index) => {
      if (index === 1) throw new Error("candidate rejected");
      return `task-${index}`;
    },
  });
  assert.deepEqual(result, {
    acceptedTaskIds: ["task-0", "task-2"],
    rejectedCount: 1,
    costCents: 60,
  });
});

test("video best-of fails only when no candidate was accepted", async () => {
  await assert.rejects(
    submitVideoCandidates({
      count: 2,
      totalCostCents: 40,
      submit: async () => { throw new Error("provider unavailable"); },
    }),
    /0\/2 accepted.*provider unavailable/
  );
});

test("video best-of rejects an invalid candidate count before submission", async () => {
  let calls = 0;
  await assert.rejects(
    submitVideoCandidates({ count: 1, totalCostCents: 20, submit: async () => ++calls }),
    /at least 2/
  );
  assert.equal(calls, 0);
});
