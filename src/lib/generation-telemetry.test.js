import test from "node:test";
import assert from "node:assert/strict";

import {
  buildGenerationEvent,
  persistGenerationFailure,
} from "@/lib/generation-telemetry";

const failed = {
  id: "generation-1",
  kind: "video",
  model: "Gemini Omni Flash",
  status: "failed",
  error: "Input blocked",
  moderationBlocked: true,
  prompt: "SECRET PROMPT",
  userId: "SECRET USER",
  taskId: "SECRET TASK",
  referenceImages: ["SECRET URL"],
};

test("generation telemetry has a stable privacy-bounded shape", () => {
  const event = buildGenerationEvent({
    route: "video_status",
    phase: "provider_status",
    item: failed,
    persisted: true,
    timestamp: 123,
  });
  assert.deepEqual(event, {
    event: "generation_failure",
    version: 1,
    route: "video_status",
    phase: "provider_status",
    generationId: "generation-1",
    kind: "video",
    model: "Gemini Omni Flash",
    errorCode: "moderation",
    moderationBlocked: true,
    persisted: true,
    timestamp: 123,
  });
  const serialized = JSON.stringify(event);
  for (const secret of ["SECRET PROMPT", "SECRET USER", "SECRET TASK", "SECRET URL"]) {
    assert.doesNotMatch(serialized, new RegExp(secret));
  }
});

test("persistGenerationFailure persists before emitting one terminal event", async () => {
  const order = [];
  await persistGenerationFailure(
    failed,
    { route: "video_status", phase: "provider_status" },
    {
      persist: async (item) => order.push(`persist:${item.id}`),
      logger: (line) => order.push(JSON.parse(line).event),
    }
  );
  assert.deepEqual(order, ["persist:generation-1", "generation_failure"]);
});

test("a persistence error emits a distinct event and is rethrown", async () => {
  const events = [];
  await assert.rejects(
    persistGenerationFailure(
      failed,
      { route: "queue_execute", phase: "submission" },
      {
        persist: async () => { throw new Error("database unavailable"); },
        logger: (line) => events.push(JSON.parse(line)),
      }
    ),
    /database unavailable/
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "generation_persistence_failure");
  assert.equal(events[0].persisted, false);
});

test("persistGenerationFailure rejects a non-failed row", async () => {
  await assert.rejects(
    persistGenerationFailure({ ...failed, status: "running" }, {}),
    /requires status=failed/
  );
});
