import { test } from "vitest";
import assert from "node:assert/strict";
import {
  admits,
  bestOfMultiplier,
  holdRetryAfterMs,
  spendLimitCents,
  DEFAULT_SPEND_LIMIT_CENTS,
  SPEND_WINDOW_MS,
} from "./spend-window";

// ── admits ──────────────────────────────────────────────────────────────────

test("admits: lets a job through when the window has room", () => {
  assert.equal(
    admits({ windowCents: 40, jobCents: 50, limitCents: 150, windowBusy: true }),
    true
  );
});

test("admits: holds a job that would cross the budget", () => {
  assert.equal(
    admits({ windowCents: 130, jobCents: 50, limitCents: 150, windowBusy: true }),
    false
  );
});

test("admits: landing exactly on the budget is allowed, not held", () => {
  assert.equal(
    admits({ windowCents: 40, jobCents: 50, limitCents: 150, windowBusy: true }),
    true
  );
});

test("admits: an empty window always admits, guaranteeing forward progress", () => {
  // A single job priced above the entire budget must still run — the window can
  // never drain below its cost, so without this it would be held forever.
  assert.equal(
    admits({ windowCents: 0, jobCents: 5000, limitCents: 150, windowBusy: false }),
    true
  );
});

test("admits: a busy window still holds an over-budget job", () => {
  assert.equal(
    admits({ windowCents: 10, jobCents: 5000, limitCents: 150, windowBusy: true }),
    false
  );
});

test("admits: limit of 0 disables the gate entirely", () => {
  assert.equal(
    admits({ windowCents: 99999, jobCents: 99999, limitCents: 0, windowBusy: true }),
    true
  );
});

// ── spendLimitCents ─────────────────────────────────────────────────────────

test("spendLimitCents: falls back to the default when unset or junk", () => {
  assert.equal(spendLimitCents({}), DEFAULT_SPEND_LIMIT_CENTS);
  assert.equal(
    spendLimitCents({ GEMINI_SPEND_LIMIT_CENTS: "abc" }),
    DEFAULT_SPEND_LIMIT_CENTS
  );
  assert.equal(
    spendLimitCents({ GEMINI_SPEND_LIMIT_CENTS: "-5" }),
    DEFAULT_SPEND_LIMIT_CENTS
  );
});

test("spendLimitCents: honours an explicit value, including 0 as opt-out", () => {
  assert.equal(
    spendLimitCents({ GEMINI_SPEND_LIMIT_CENTS: "19000" }),
    19000
  );
  assert.equal(
    spendLimitCents({ GEMINI_SPEND_LIMIT_CENTS: "0" }),
    0
  );
});

// ── bestOfMultiplier ────────────────────────────────────────────────────────

test("bestOfMultiplier: mirrors the route's clamp (default 2, max 4, min 1)", () => {
  assert.equal(bestOfMultiplier({}), 2);
  assert.equal(bestOfMultiplier({ FACE_BEST_OF: "1" }), 1);
  assert.equal(bestOfMultiplier({ FACE_BEST_OF: "4" }), 4);
  assert.equal(bestOfMultiplier({ FACE_BEST_OF: "9" }), 4);
  assert.equal(bestOfMultiplier({ FACE_BEST_OF: "0" }), 2);
});

// ── holdRetryAfterMs ────────────────────────────────────────────────────────

test("holdRetryAfterMs: waits until the oldest row leaves the window", () => {
  const now = 1_000_000;
  // Oldest row was touched 4 minutes ago, so 6 minutes of the window remain.
  const oldest = now - 4 * 60 * 1000;
  assert.equal(holdRetryAfterMs(oldest, now), 6 * 60 * 1000);
});

test("holdRetryAfterMs: floors at 5s so a client cannot busy-poll", () => {
  const now = 1_000_000;
  // Oldest row is a milliseconds away from ageing out.
  assert.equal(holdRetryAfterMs(now - SPEND_WINDOW_MS + 10, now), 5_000);
  // Already past the window (clock skew) — still floored, never negative.
  assert.equal(holdRetryAfterMs(now - SPEND_WINDOW_MS - 60_000, now), 5_000);
});

test("holdRetryAfterMs: caps at the window length against a skewed future stamp", () => {
  const now = 1_000_000;
  assert.equal(holdRetryAfterMs(now + 60 * 60 * 1000, now), SPEND_WINDOW_MS);
});

test("holdRetryAfterMs: defaults to 5s when the window is empty", () => {
  assert.equal(holdRetryAfterMs(null, 1_000_000), 5_000);
});
