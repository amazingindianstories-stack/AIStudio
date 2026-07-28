import test from "node:test";
import assert from "node:assert/strict";
import { retryDelayMs } from "./gemini";

/** A real 429 body, shaped like the one measured on 2026-07-28 when a burst of
 *  21:9/2K best-of-N renders tripped the spend-based rate limit. */
function resourceExhausted(retryDelay?: string) {
  return JSON.stringify({
    error: {
      code: 429,
      message: "You exceeded your spend-based rate limit.",
      status: "RESOURCE_EXHAUSTED",
      details: [
        { "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [] },
        ...(retryDelay
          ? [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay }]
          : []),
      ],
    },
  });
}

test("retryDelayMs: reads RetryInfo.retryDelay and converts seconds to ms", () => {
  assert.equal(retryDelayMs(resourceExhausted("31s")), 31_000);
});

test("retryDelayMs: accepts fractional Duration strings", () => {
  assert.equal(retryDelayMs(resourceExhausted("1.5s")), 1_500);
});

test("retryDelayMs: clamps a 0s hint up, so a retry can never busy-loop", () => {
  assert.equal(retryDelayMs(resourceExhausted("0s")), 1_000);
});

test("retryDelayMs: clamps an absurd hint down, so one job can't strand the invocation", () => {
  assert.equal(retryDelayMs(resourceExhausted("3600s")), 60_000);
});

test("retryDelayMs: returns null when there is no RetryInfo detail", () => {
  assert.equal(retryDelayMs(resourceExhausted()), null);
});

test("retryDelayMs: returns null on a non-JSON body (HTML error pages, proxy text)", () => {
  assert.equal(retryDelayMs("<html>502 Bad Gateway</html>"), null);
});

test("retryDelayMs: returns null when details is present but not an array", () => {
  assert.equal(
    retryDelayMs(JSON.stringify({ error: { details: "nope" } })),
    null
  );
});

test("retryDelayMs: ignores a RetryInfo whose retryDelay is missing or malformed", () => {
  assert.equal(retryDelayMs(resourceExhausted("soon")), null);
  assert.equal(
    retryDelayMs(
      JSON.stringify({
        error: { details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo" }] },
      })
    ),
    null
  );
});
