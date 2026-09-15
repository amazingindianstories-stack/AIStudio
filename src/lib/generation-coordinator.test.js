import assert from "node:assert/strict";
import test from "node:test";
import { isCoordinatorEligible, normalizeProviderTimestamp, providerTimestamps } from "./generation-coordinator";

test("provider timestamps normalize seconds, milliseconds, and ISO strings", () => {
  assert.equal(normalizeProviderTimestamp(1788940000), 1788940000000);
  assert.equal(normalizeProviderTimestamp(1788940000000), 1788940000000);
  assert.equal(normalizeProviderTimestamp("2026-09-09T00:00:00.000Z"), Date.parse("2026-09-09T00:00:00.000Z"));
  assert.deepEqual(providerTimestamps({ data: { created_at: 10, status: "running" } }), {
    providerCreatedAt: 10000, providerUpdatedAt: undefined, providerStatus: "running",
  });
});

test("coordinator includes queued image/video and running video only", () => {
  assert.equal(isCoordinatorEligible({ kind: "image", status: "queued" }), true);
  assert.equal(isCoordinatorEligible({ kind: "video", status: "queued" }), true);
  assert.equal(isCoordinatorEligible({ kind: "video", status: "running" }), true);
  assert.equal(isCoordinatorEligible({ kind: "image", status: "running" }), false);
  assert.equal(isCoordinatorEligible({ kind: "depth", status: "queued" }), false);
  assert.equal(isCoordinatorEligible({ kind: "depth", status: "running" }), false);
});
