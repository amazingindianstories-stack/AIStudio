/**
 * Guard: the stale-job reaper's threshold must stay above the execute
 * route's invocation budget.
 *
 * WHY THIS EXISTS
 * `/api/queue/execute` runs a whole generation inside one invocation, and
 * `store-db.js`'s reaper fails any image job still `running` after
 * STALE_RUNNING_MS. A job's `updated_at` is stamped once by `lockJob` and not
 * touched again until it finishes, so a slow-but-healthy job is
 * indistinguishable from a dead one until its invocation budget is provably
 * spent. If STALE_RUNNING_MS ever drops below `maxDuration`, the reaper starts
 * failing jobs that are still legitimately running — and the symptom looks
 * like flaky providers, not like a config mismatch.
 *
 * store-db.js says "MUST stay comfortably above this value" and notes the two
 * constants cannot share an import: Next requires a statically analysable
 * literal for `maxDuration`, so it cannot be `export const maxDuration =
 * SOME_IMPORT`. A comment is therefore the only link between them — which is
 * to say, no link at all.
 *
 * Reading both files as text is ugly. It is also the only mechanism this
 * constraint can have, given the framework constraint above.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const EXECUTE_ROUTE = "src/app/api/queue/execute/route.js";
const STORE_DB = "src/lib/store-db.js";

/** Slack between the invocation budget and the reap threshold. The current
 *  values are 300 s and 7 min, i.e. 120 s of slack; require at least 60 s so
 *  a narrowing change has to be deliberate. */
const MIN_SLACK_MS = 60_000;

function readMaxDurationSeconds() {
  const src = readFileSync(EXECUTE_ROUTE, "utf8");
  const m = /^export const maxDuration\s*=\s*(\d+)\s*;/m.exec(src);
  assert.ok(
    m,
    `could not find "export const maxDuration = <number>;" in ${EXECUTE_ROUTE}. ` +
      `If the export was renamed or made non-literal, this guard is no longer ` +
      `checking anything — fix the regex rather than deleting the test.`
  );
  return Number(m[1]);
}

function readStaleRunningMs() {
  const src = readFileSync(STORE_DB, "utf8");
  // e.g. `const STALE_RUNNING_MS = 7 * 60 * 1000;`
  const m = /^const STALE_RUNNING_MS\s*=\s*([0-9*\s_]+);/m.exec(src);
  assert.ok(
    m,
    `could not find "const STALE_RUNNING_MS = <expression>;" in ${STORE_DB}. ` +
      `Fix the regex rather than deleting the test.`
  );
  const value = m[1]
    .replace(/_/g, "")
    .split("*")
    .map((part) => Number(part.trim()))
    .reduce((a, b) => a * b, 1);
  assert.ok(Number.isFinite(value) && value > 0, `parsed a nonsense STALE_RUNNING_MS: ${m[1]}`);
  return value;
}

test("STALE_RUNNING_MS stays above /api/queue/execute's maxDuration", () => {
  const maxDurationMs = readMaxDurationSeconds() * 1000;
  const staleMs = readStaleRunningMs();

  assert.ok(
    staleMs >= maxDurationMs + MIN_SLACK_MS,
    `STALE_RUNNING_MS (${staleMs} ms) must exceed /api/queue/execute's ` +
      `maxDuration (${maxDurationMs} ms) by at least ${MIN_SLACK_MS} ms.\n\n` +
      `As written, the reaper would fail jobs that are still legitimately ` +
      `running: lockJob stamps updated_at once and nothing touches it again ` +
      `until the job finishes, so a healthy long job looks exactly like a ` +
      `dead one. Raise STALE_RUNNING_MS in ${STORE_DB}, or lower maxDuration ` +
      `in ${EXECUTE_ROUTE}.`
  );
});
