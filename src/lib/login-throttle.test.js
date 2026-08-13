import { test } from "node:test";
import assert from "node:assert/strict";
import {
  admitsLoginAttempt,
  loginRetryAfterMs,
  maxLoginAttempts,
  LOGIN_ATTEMPT_WINDOW_MS,
} from "./login-throttle.js";

test("admitsLoginAttempt: allows attempts below the max", () => {
  assert.equal(admitsLoginAttempt({ recentFailureCount: 0, maxAttempts: 5 }), true);
  assert.equal(admitsLoginAttempt({ recentFailureCount: 4, maxAttempts: 5 }), true);
});

test("admitsLoginAttempt: blocks once the count reaches the max", () => {
  assert.equal(admitsLoginAttempt({ recentFailureCount: 5, maxAttempts: 5 }), false);
  assert.equal(admitsLoginAttempt({ recentFailureCount: 9, maxAttempts: 5 }), false);
});

test("admitsLoginAttempt: maxAttempts <= 0 disables the gate entirely", () => {
  assert.equal(admitsLoginAttempt({ recentFailureCount: 999, maxAttempts: 0 }), true);
  assert.equal(admitsLoginAttempt({ recentFailureCount: 999, maxAttempts: -1 }), true);
});

test("loginRetryAfterMs: no failures yet returns 0", () => {
  assert.equal(loginRetryAfterMs(null, Date.now()), 0);
});

test("loginRetryAfterMs: waits until the oldest failure ages out of the window", () => {
  const now = 1_000_000;
  const oldestFailureAt = now - 1000; // 1s into the window
  assert.equal(loginRetryAfterMs(oldestFailureAt, now), LOGIN_ATTEMPT_WINDOW_MS - 1000);
});

test("loginRetryAfterMs: never returns negative even past the window (clock skew)", () => {
  const now = 1_000_000;
  const oldestFailureAt = now - LOGIN_ATTEMPT_WINDOW_MS - 5000; // already expired
  assert.equal(loginRetryAfterMs(oldestFailureAt, now), 0);
});

test("maxLoginAttempts: falls back to the default when unset or junk", () => {
  assert.equal(maxLoginAttempts({}), 5);
  assert.equal(maxLoginAttempts({ LOGIN_MAX_ATTEMPTS: "not-a-number" }), 5);
  assert.equal(maxLoginAttempts({ LOGIN_MAX_ATTEMPTS: "-3" }), 5);
});

test("maxLoginAttempts: honours an explicit value, including 0 as opt-out", () => {
  assert.equal(maxLoginAttempts({ LOGIN_MAX_ATTEMPTS: "10" }), 10);
  assert.equal(maxLoginAttempts({ LOGIN_MAX_ATTEMPTS: "0" }), 0);
});
