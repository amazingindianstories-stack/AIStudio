import assert from "node:assert/strict";
import test from "node:test";
import {
  retryAfterMsForPollErrors,
  videoPollClientDecision,
  VIDEO_POLL_BASE_MS,
  VIDEO_POLL_MAX_MS,
} from "./video-poll-backoff";

test("video poll retry delay doubles and caps at one minute", () => {
  assert.equal(retryAfterMsForPollErrors(1), VIDEO_POLL_BASE_MS);
  assert.equal(retryAfterMsForPollErrors(2), 8_000);
  assert.equal(retryAfterMsForPollErrors(99), VIDEO_POLL_MAX_MS);
});

test("transient response produces a non-terminal warning and bounded backoff", () => {
  const decision = videoPollClientDecision({
    transientPollError: true, pollErrorCount: 3, retryAfterMs: 16_000,
  });
  assert.equal(decision.transient, true);
  assert.equal(decision.retryAfterMs, 16_000);
  assert.match(decision.warning, /Retrying automatically/);
  assert.equal(decision.item, undefined);
});

test("successful provider response resets client delay and warning", () => {
  const decision = videoPollClientDecision({ id: "generation", status: "running" });
  assert.equal(decision.transient, false);
  assert.equal(decision.retryAfterMs, VIDEO_POLL_BASE_MS);
  assert.equal(decision.item.pollWarning, undefined);
});
