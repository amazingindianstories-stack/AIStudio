import assert from "node:assert/strict";
import test from "node:test";
import { generationEvent, normalizeProviderTimestamp, providerTimestamps } from "./generation-coordinator";

test("provider timestamps normalize seconds, milliseconds, and ISO strings", () => {
  assert.equal(normalizeProviderTimestamp(1788940000), 1788940000000);
  assert.equal(normalizeProviderTimestamp(1788940000000), 1788940000000);
  assert.equal(normalizeProviderTimestamp("2026-09-09T00:00:00.000Z"), Date.parse("2026-09-09T00:00:00.000Z"));
});

test("provider payload timestamps and event envelope are stable", () => {
  const times = providerTimestamps({ data: { created_at: 10, updated_at: 20, status: "running" } });
  assert.deepEqual(times, { providerCreatedAt: 10000, providerUpdatedAt: 20000, providerStatus: "running" });
  assert.deepEqual(generationEvent({ id: "g", status: "running", updatedAt: 99 }, 12), {
    type: "generation.updated", generationId: "g", status: "running", updatedAt: 99, version: 12,
  });
});
