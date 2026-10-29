import assert from "node:assert/strict";
import test from "node:test";
import { ACTIVE_POLL_MS, IDLE_AFTER_MS, IDLE_POLL_MS, pollDelay } from "./use-board-polling.js";

test("polling is fast while people work, slower when idle and stopped while hidden", () => {
  assert.equal(pollDelay({ visible: true, idleForMs: 0 }), ACTIVE_POLL_MS);
  assert.equal(pollDelay({ visible: true, idleForMs: IDLE_AFTER_MS - 1 }), ACTIVE_POLL_MS);
  assert.equal(pollDelay({ visible: true, idleForMs: IDLE_AFTER_MS }), IDLE_POLL_MS);
  assert.equal(pollDelay({ visible: false, idleForMs: 0 }), null);
  assert.ok(ACTIVE_POLL_MS <= 5000, "other people's edits appear within seconds");
});
