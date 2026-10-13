import assert from "node:assert/strict";
import test from "node:test";
import {
  LIVE_ACTIVE_WINDOW_MS,
  LIVE_MS_ACTIVE,
  LIVE_MS_DRAIN,
  LIVE_MS_IDLE,
  LIVE_MS_MAX_BACKOFF,
  hasRecentActiveWork,
  liveDelay,
  liveUpdatesUrl,
  nextLiveCursor,
} from "./live-cursor.js";

test("server cursor wins over the legacy now watermark", () => {
  const current = { since: 1, afterId: null };
  assert.deepEqual(nextLiveCursor({ next: { since: 50, afterId: "id-9" }, now: 900 }, current), { since: 50, afterId: "id-9" });
  assert.deepEqual(nextLiveCursor({ next: { since: 70, afterId: null }, now: 900 }, current), { since: 70, afterId: null });
  assert.deepEqual(nextLiveCursor({ now: 900 }, current), { since: 900, afterId: null });
  assert.deepEqual(nextLiveCursor({}, current), current);
  assert.deepEqual(nextLiveCursor({ next: { since: "bad" } }, current), current);
});

test("updates URL carries the tie-break id only while paging", () => {
  assert.equal(liveUpdatesUrl({ since: 123, afterId: null }), "/api/history/updates?since=123");
  assert.equal(liveUpdatesUrl({ since: 123, afterId: "a-b" }), "/api/history/updates?since=123&afterId=a-b");
});

test("draining, busy, idle and bounded failure backoff", () => {
  assert.equal(liveDelay({ more: true, busy: true }), LIVE_MS_DRAIN);
  assert.equal(liveDelay({ busy: true }), LIVE_MS_ACTIVE);
  assert.equal(liveDelay({}), LIVE_MS_IDLE);
  assert.equal(liveDelay({ failures: 1, more: true }), LIVE_MS_IDLE);
  assert.equal(liveDelay({ failures: 2 }), LIVE_MS_IDLE * 2);
  assert.equal(liveDelay({ failures: 20 }), LIVE_MS_MAX_BACKOFF);
});

test("a long-stuck running row no longer forces the fast cadence", () => {
  const now = 10_000_000;
  assert.equal(hasRecentActiveWork([{ status: "running", updatedAt: now - 1000 }], now), true);
  assert.equal(hasRecentActiveWork([{ status: "running", updatedAt: now - LIVE_ACTIVE_WINDOW_MS - 1 }], now), false);
  assert.equal(hasRecentActiveWork([{ status: "succeeded", updatedAt: now }], now), false);
  assert.equal(hasRecentActiveWork([{ status: "queued" }], now), true);
});
