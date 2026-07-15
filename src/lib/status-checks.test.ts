/**
 * Unit tests for src/lib/status-checks.ts — the Admin API Status Page's
 * check registry, timeout/measure wrapper (`runCheck`), and batch aggregator
 * (`runAllChecks`).
 *
 * Derived independently from:
 *   - .council/admin-status-page/spec.md (acceptance criteria 1-10)
 *   - .council/admin-status-page/design.md §3 (data model), §4 (module
 *     interfaces), §5 (timeout/measure wrapper contract), §13 (test seams)
 * BEFORE reading any implementation of status-checks.ts (written in parallel
 * by another agent; at test-authoring time the file did not yet exist).
 *
 * Per design.md §13, this file only exercises the *seams* that are pure/
 * synthetic-injectable:
 *   - `runCheck`'s timeout/measure/never-throws contract, driven by
 *     fabricated `CheckDef`s (not real network calls).
 *   - `runAllChecks`'s aggregation/parallelism/isolation contract, driven by
 *     the `checks?` parameter (the documented test-injection seam) rather
 *     than the real `CHECKS` registry (which touches live Gemini/Postgres/
 *     GCS/Higgsfield credentials and network).
 *   - The `CheckResult`/`StatusResponse` shape contract.
 *
 * Deliberately NOT covered here (per design.md §13's own scoping — live
 * network/credentials required, would be flaky or, for Gemini, non-free to
 * run repeatedly in CI even though the specific call is non-billable):
 *   - `checkGemini`, `checkHiggsfield`, `checkPostgres`, `checkGcs` — the real
 *     per-dependency functions inside `CHECKS`. Left to manual review against
 *     a live/staging environment.
 *   - `checkSeedance` / `checkOmni` config-presence logic — see the note
 *     immediately above the "config-presence" describe block below for why
 *     these are treated as a documented gap rather than tested directly.
 *   - The `StatusTab` React component and the `/api/admin/status` route's
 *     admin-gate wiring — no React test harness exists in this repo (per
 *     design.md §13); route-level auth gating (403 for non-admin) is a
 *     manual/integration-test concern, not a pure unit of status-checks.ts.
 *
 * Run:
 *   npx tsx --test src/lib/status-checks.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  runCheck,
  runAllChecks,
  checkSeedance,
  checkOmni,
  type CheckResult,
  type StatusResponse,
} from "./status-checks";

// A minimal local stand-in for the module-private `CheckDef`/`CheckFn` types
// (design.md §4 declares `CheckDef`/`CheckFn` but does not export them —
// only `CHECKS`, `runCheck`, `runAllChecks`, and the result/response types
// are part of the public surface). Structurally identical to the contract.
type CheckStatus = "ok" | "error" | "unknown";
type CheckOutcome = { status: CheckStatus; detail: string };
type CheckFn = (signal: AbortSignal) => Promise<CheckOutcome>;
interface CheckDef {
  id: string;
  name: string;
  fn: CheckFn;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function def(id: string, name: string, fn: CheckFn): CheckDef {
  return { id, name, fn };
}

// ---------------------------------------------------------------------------
// runCheck — timeout / measure wrapper contract (design.md §5)
// ---------------------------------------------------------------------------

test("runCheck: fast ok resolution — copies id/name from def, preserves status/detail, has numeric latency and checkedAt", async () => {
  const d = def("synthetic-ok", "Synthetic OK Check", async () => ({
    status: "ok" as const,
    detail: "x",
  }));
  const result = await runCheck(d);
  assert.equal(result.id, "synthetic-ok");
  assert.equal(result.name, "Synthetic OK Check");
  assert.equal(result.status, "ok");
  assert.equal(result.detail, "x");
  assert.equal(typeof result.latencyMs, "number");
  assert.ok(result.latencyMs >= 0);
  assert.equal(typeof result.checkedAt, "number");
});

test("runCheck: fast unknown resolution passes the outcome through unmodified (not coerced to error)", async () => {
  const d = def("synthetic-unknown", "Synthetic Unknown Check", async () => ({
    status: "unknown" as const,
    detail: "config absent",
  }));
  const result = await runCheck(d);
  assert.equal(result.status, "unknown");
  assert.equal(result.detail, "config absent");
});

test("runCheck: fn rejecting with an Error is caught into an error result carrying the message, never throws", async () => {
  const d = def("synthetic-reject", "Synthetic Reject Check", async () => {
    throw new Error("boom");
  });
  let result: CheckResult | undefined;
  try {
    result = await runCheck(d);
  } catch {
    assert.fail("runCheck must never reject, even when the CheckFn rejects");
  }
  assert.equal(result!.status, "error");
  assert.equal(result!.detail, "boom");
});

test("runCheck: fn that throws synchronously (before returning a promise) is still caught, never throws", async () => {
  // Edge case beyond the literal design.md examples: a CheckFn is typed to
  // return a Promise, but a buggy/defensive implementation could still throw
  // synchronously before constructing one. runCheck's "never rejects"
  // guarantee (§5 point 6, §7/AC9 "no exception crosses the route boundary")
  // should hold even here.
  const d = def("synthetic-sync-throw", "Synthetic Sync Throw Check", (() => {
    throw new Error("sync boom");
  }) as unknown as CheckFn);
  let result: CheckResult | undefined;
  try {
    result = await runCheck(d);
  } catch {
    assert.fail("runCheck must never reject, even when the CheckFn throws synchronously");
  }
  assert.equal(result!.status, "error");
});

test("runCheck: fn rejecting with a non-Error value falls back to a string detail, never throws", async () => {
  const d = def("synthetic-reject-nonerror", "Synthetic Reject Non-Error Check", async () => {
    // eslint-disable-next-line @typescript-eslint/no-throw-literal
    throw "plain string failure";
  });
  let result: CheckResult | undefined;
  try {
    result = await runCheck(d);
  } catch {
    assert.fail("runCheck must never reject");
  }
  assert.equal(result!.status, "error");
  assert.equal(typeof result!.detail, "string");
  assert.ok(result!.detail.length > 0);
});

test("runCheck: a never-resolving fn times out within the given timeoutMs and reports an error mentioning the timeout", async () => {
  const d = def("synthetic-hang", "Synthetic Hang Check", () => new Promise<CheckOutcome>(() => {
    /* never resolves */
  }));
  const start = Date.now();
  let result: CheckResult | undefined;
  try {
    result = await runCheck(d, 20);
  } catch {
    assert.fail("runCheck must never reject on timeout");
  }
  const elapsed = Date.now() - start;
  // Generous bound: proves it settles promptly on the timeout, not that it
  // settles at exactly 20ms (avoids flakiness under CI/system load).
  assert.ok(elapsed < 200, `expected runCheck to settle well under 200ms, took ${elapsed}ms`);
  assert.equal(result!.status, "error");
  assert.match(result!.detail, /timed out/i);
});

test("runCheck: a fn that resolves after the timeout elapses still yields a timeout error, not the late resolution", async () => {
  const d = def("synthetic-late", "Synthetic Late Check", async () => {
    await sleep(150);
    return { status: "ok" as const, detail: "too late" };
  });
  const result = await runCheck(d, 20);
  assert.equal(result.status, "error");
  assert.match(result.detail, /timed out/i);
});

test("runCheck: passes an AbortSignal to fn, and that signal is aborted once the timeout fires", async () => {
  let observedSignal: AbortSignal | undefined;
  const d = def("synthetic-signal", "Synthetic Signal Check", (signal) => {
    observedSignal = signal;
    return new Promise<CheckOutcome>(() => {
      /* never resolves; only the signal + Promise.race bound this */
    });
  });
  await runCheck(d, 20);
  assert.ok(observedSignal instanceof AbortSignal, "fn must receive a real AbortSignal");
  assert.equal(observedSignal!.aborted, true);
});

test("runCheck: default timeoutMs (no second argument) does not spuriously fail a check that resolves well within it", async () => {
  // Does not actually wait out the real 5000ms default; just confirms that
  // omitting timeoutMs is a valid call shape and a quick-resolving check
  // still comes back "ok" rather than being coerced into an error.
  const d = def("synthetic-default-timeout", "Synthetic Default Timeout Check", async () => {
    await sleep(10);
    return { status: "ok" as const, detail: "fine" };
  });
  const result = await runCheck(d);
  assert.equal(result.status, "ok");
  assert.equal(result.detail, "fine");
});

test("runCheck: never rejects across ok / error / timeout scenarios (explicit guarantee check)", async () => {
  const scenarios: CheckDef[] = [
    def("s-ok", "S OK", async () => ({ status: "ok" as const, detail: "ok" })),
    def("s-err", "S Err", async () => {
      throw new Error("nope");
    }),
    def("s-timeout", "S Timeout", () => new Promise<CheckOutcome>(() => {})),
  ];
  for (const s of scenarios) {
    await assert.doesNotReject(
      async () => runCheck(s, 15),
      `runCheck must never reject for scenario "${s.id}"`
    );
  }
});

// ---------------------------------------------------------------------------
// runAllChecks — aggregation, parallelism, and isolation (design.md §5/§7)
// ---------------------------------------------------------------------------

test("runAllChecks: aggregates a mix of ok / rejecting / timing-out checks without throwing, preserving count and order", async () => {
  const checks: CheckDef[] = [
    def("zeta", "Zeta", async () => ({ status: "ok" as const, detail: "fine" })),
    def("alpha", "Alpha", async () => {
      throw new Error("alpha failed");
    }),
    def("mike", "Mike", () => new Promise<CheckOutcome>(() => {})),
    def("bravo", "Bravo", async () => ({ status: "unknown" as const, detail: "no config" })),
  ];

  let response: StatusResponse | undefined;
  await assert.doesNotReject(async () => {
    response = await runAllChecks(checks, 30);
  });

  assert.ok(response);
  assert.equal(typeof response!.checkedAt, "number");
  assert.equal(response!.checks.length, checks.length);
  assert.deepEqual(
    response!.checks.map((c) => c.id),
    ["zeta", "alpha", "mike", "bravo"],
    "result order must match input order, not e.g. completion order or alphabetical order"
  );

  const [zeta, alpha, mike, bravo] = response!.checks;
  assert.equal(zeta.status, "ok");
  assert.equal(alpha.status, "error");
  assert.match(alpha.detail, /alpha failed/);
  assert.equal(mike.status, "error");
  assert.match(mike.detail, /timed out/i);
  assert.equal(bravo.status, "unknown");
});

test("runAllChecks: empty checks array resolves to an empty, well-shaped response rather than throwing", async () => {
  const response = await runAllChecks([], 50);
  assert.equal(typeof response.checkedAt, "number");
  assert.deepEqual(response.checks, []);
});

test("runAllChecks: a single throwing/hung check never rejects the whole batch (AC5/AC9 at the unit level)", async () => {
  const checks: CheckDef[] = [
    def("only-one", "Only One", () => new Promise<CheckOutcome>(() => {})),
  ];
  await assert.doesNotReject(async () => runAllChecks(checks, 20));
});

test("runAllChecks: checks run in parallel, not sequentially (total wall time is close to one check's delay, not the sum)", async () => {
  const perCheckDelayMs = 80;
  const count = 4;
  const checks: CheckDef[] = Array.from({ length: count }, (_, i) =>
    def(`slow-${i}`, `Slow ${i}`, async () => {
      await sleep(perCheckDelayMs);
      return { status: "ok" as const, detail: "done" };
    })
  );

  const start = Date.now();
  const response = await runAllChecks(checks, 5000);
  const elapsed = Date.now() - start;

  assert.equal(response.checks.length, count);
  assert.ok(
    response.checks.every((c) => c.status === "ok"),
    "all synthetic checks should report ok"
  );
  // If run sequentially this would take >= 4 * 80ms = 320ms. A generous
  // bound well under that (but comfortably above the 80ms floor for system
  // jitter) demonstrates parallel execution without being flaky.
  assert.ok(
    elapsed < perCheckDelayMs * count * 0.75,
    `expected parallel execution (~${perCheckDelayMs}ms), but took ${elapsed}ms — looks sequential`
  );
});

test("runAllChecks: checkedAt reflects the batch start time (a real, current timestamp)", async () => {
  const before = Date.now();
  const response = await runAllChecks(
    [def("quick", "Quick", async () => ({ status: "ok" as const, detail: "x" }))],
    50
  );
  const after = Date.now();
  assert.ok(response.checkedAt >= before && response.checkedAt <= after);
});

// ---------------------------------------------------------------------------
// Response-shape contract (design.md §3) — guards against silent drift
// ---------------------------------------------------------------------------

test("CheckResult shape: field set and types match the documented contract exactly", async () => {
  const result = await runCheck(
    def("shape-check", "Shape Check", async () => ({ status: "ok" as const, detail: "shape" }))
  );
  assert.equal(typeof result.id, "string");
  assert.equal(typeof result.name, "string");
  assert.ok(["ok", "error", "unknown"].includes(result.status));
  assert.equal(typeof result.detail, "string");
  assert.equal(typeof result.latencyMs, "number");
  assert.equal(typeof result.checkedAt, "number");
});

test("StatusResponse shape: top-level field set and per-check status is always one of the three literal values", async () => {
  const checks: CheckDef[] = [
    def("a", "A", async () => ({ status: "ok" as const, detail: "1" })),
    def("b", "B", async () => ({ status: "unknown" as const, detail: "2" })),
    def("c", "C", async () => {
      throw new Error("3");
    }),
  ];
  const response = await runAllChecks(checks, 50);
  assert.equal(typeof response.checkedAt, "number");
  assert.ok(Array.isArray(response.checks));
  for (const c of response.checks) {
    assert.ok(["ok", "error", "unknown"].includes(c.status), `unexpected status: ${c.status}`);
  }
});

/**
 * ---------------------------------------------------------------------------
 * checkSeedance / checkOmni — config-presence logic (promoted from a manual-
 * review gap, code review round 1: both functions are now exported directly
 * from status-checks.ts, so these pure env-var mappings can be exercised
 * without touching the live CHECKS registry or its Postgres/S3 clients).
 * ---------------------------------------------------------------------------
 */
test("checkSeedance: ARK_API_KEY unset -> unknown, mentions ARK_API_KEY", async () => {
  const prev = process.env.ARK_API_KEY;
  delete process.env.ARK_API_KEY;
  try {
    const r = await checkSeedance();
    assert.equal(r.status, "unknown");
    assert.match(r.detail, /ARK_API_KEY/);
  } finally {
    if (prev !== undefined) process.env.ARK_API_KEY = prev;
  }
});

test("checkSeedance: ARK_API_KEY set -> ok, mentions config-presence", async () => {
  const prev = process.env.ARK_API_KEY;
  process.env.ARK_API_KEY = "test-key";
  try {
    const r = await checkSeedance();
    assert.equal(r.status, "ok");
    assert.match(r.detail, /config-presence/);
  } finally {
    if (prev === undefined) delete process.env.ARK_API_KEY;
    else process.env.ARK_API_KEY = prev;
  }
});

test("checkOmni: OMNI_USE_VERTEX=1 + GOOGLE_CLOUD_PROJECT unset -> unknown", async () => {
  const prevVertex = process.env.OMNI_USE_VERTEX;
  const prevProject = process.env.GOOGLE_CLOUD_PROJECT;
  process.env.OMNI_USE_VERTEX = "1";
  delete process.env.GOOGLE_CLOUD_PROJECT;
  try {
    const r = await checkOmni();
    assert.equal(r.status, "unknown");
    assert.match(r.detail, /GOOGLE_CLOUD_PROJECT/);
  } finally {
    if (prevVertex === undefined) delete process.env.OMNI_USE_VERTEX;
    else process.env.OMNI_USE_VERTEX = prevVertex;
    if (prevProject !== undefined) process.env.GOOGLE_CLOUD_PROJECT = prevProject;
  }
});

test("checkOmni: OMNI_USE_VERTEX=1 + GOOGLE_CLOUD_PROJECT set -> ok", async () => {
  const prevVertex = process.env.OMNI_USE_VERTEX;
  const prevProject = process.env.GOOGLE_CLOUD_PROJECT;
  process.env.OMNI_USE_VERTEX = "1";
  process.env.GOOGLE_CLOUD_PROJECT = "test-project";
  try {
    const r = await checkOmni();
    assert.equal(r.status, "ok");
    assert.match(r.detail, /Vertex/);
  } finally {
    if (prevVertex === undefined) delete process.env.OMNI_USE_VERTEX;
    else process.env.OMNI_USE_VERTEX = prevVertex;
    if (prevProject === undefined) delete process.env.GOOGLE_CLOUD_PROJECT;
    else process.env.GOOGLE_CLOUD_PROJECT = prevProject;
  }
});

test("checkOmni: OMNI_USE_VERTEX unset, GOOGLE_API_KEY set/unset -> ok/unknown", async () => {
  const prevVertex = process.env.OMNI_USE_VERTEX;
  const prevKey = process.env.GOOGLE_API_KEY;
  delete process.env.OMNI_USE_VERTEX;
  try {
    delete process.env.GOOGLE_API_KEY;
    const rUnset = await checkOmni();
    assert.equal(rUnset.status, "unknown");
    assert.match(rUnset.detail, /GOOGLE_API_KEY/);

    process.env.GOOGLE_API_KEY = "test-key";
    const rSet = await checkOmni();
    assert.equal(rSet.status, "ok");
    assert.match(rSet.detail, /config-presence/);
  } finally {
    if (prevVertex !== undefined) process.env.OMNI_USE_VERTEX = prevVertex;
    if (prevKey === undefined) delete process.env.GOOGLE_API_KEY;
    else process.env.GOOGLE_API_KEY = prevKey;
  }
});
