import assert from "node:assert/strict";
import test from "node:test";
import {
  reconciliationTelemetry,
  runVideoReconciliation,
  VIDEO_RECONCILIATION_LIMIT,
  VIDEO_RECONCILIATION_STALE_MS,
} from "./video-reconciliation";

test("reconciliation selects five stale rows and polls sequentially", async () => {
  const selected = Array.from({ length: 8 }, (_, index) => ({ id: String(index) }));
  const order = [];
  let selection;
  const counts = await runVideoReconciliation({
    now: 10_000_000,
    select: async (options) => { selection = options; return selected.slice(0, options.limit); },
    advance: async (row) => { order.push(row.id); return { kind: "pending", item: row }; },
    deadlineMs: 1_000,
  });
  assert.equal(selection.limit, VIDEO_RECONCILIATION_LIMIT);
  assert.equal(selection.before, 10_000_000 - VIDEO_RECONCILIATION_STALE_MS);
  assert.deepEqual(order, ["0", "1", "2", "3", "4"]);
  assert.deepEqual(counts, {
    ok: true, checked: 5, succeeded: 0, failed: 0, pending: 5, pollErrors: 0, raced: 0,
  });
});

test("reconciliation aggregates outcomes without row or provider data", async () => {
  const kinds = ["succeeded", "failed", "pending", "poll_error", "raced"];
  const counts = await runVideoReconciliation({
    select: async () => kinds.map((kind) => ({ kind, prompt: "secret", taskId: "secret-task" })),
    advance: async (row) => ({ kind: row.kind }),
    deadlineMs: 1_000,
  });
  const telemetry = reconciliationTelemetry(counts);
  assert.deepEqual(counts, {
    ok: true, checked: 5, succeeded: 1, failed: 1, pending: 1, pollErrors: 1, raced: 1,
  });
  assert.equal(JSON.stringify(telemetry).includes("secret"), false);
  assert.deepEqual(Object.keys(counts), ["ok", "checked", "succeeded", "failed", "pending", "pollErrors", "raced"]);
});

test("reconciliation returns within its internal deadline", async () => {
  const started = Date.now();
  const counts = await runVideoReconciliation({
    select: async () => [{ id: "slow" }],
    advance: async () => new Promise(() => {}),
    deadlineMs: 20,
  });
  assert.equal(counts.ok, false);
  assert.equal(counts.checked, 1);
  assert.ok(Date.now() - started < 250);
});
