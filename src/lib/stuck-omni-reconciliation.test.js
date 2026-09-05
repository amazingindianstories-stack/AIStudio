import { test } from "vitest";
import assert from "node:assert/strict";

import {
  classifyOmniReconciliationResult,
  DEFAULT_OMNI_RECONCILE_MAX_ROWS,
  DEFAULT_OMNI_RECONCILE_MIN_AGE_MINUTES,
  parseOmniReconcileArgs,
} from "@/lib/stuck-omni-reconciliation";

test("Omni reconciliation is bounded and dry-run by default", () => {
  assert.deepEqual(parseOmniReconcileArgs([]), {
    apply: false,
    help: false,
    minAgeMinutes: DEFAULT_OMNI_RECONCILE_MIN_AGE_MINUTES,
    maxRows: DEFAULT_OMNI_RECONCILE_MAX_ROWS,
  });
});

test("Omni reconciliation parses explicit safe bounds", () => {
  assert.deepEqual(
    parseOmniReconcileArgs(["--apply", "--min-age-minutes=90", "--max-rows=12"]),
    { apply: true, help: false, minAgeMinutes: 90, maxRows: 12 }
  );
});

test("Omni reconciliation rejects unknown and unsafe options", () => {
  assert.throws(() => parseOmniReconcileArgs(["--all"]), /Unknown option/);
  assert.throws(() => parseOmniReconcileArgs(["--max-rows=0"]), /between 1 and 500/);
  assert.throws(() => parseOmniReconcileArgs(["--min-age-minutes=0"]), /between 1 and 10080/);
});

test("Omni reconciliation only treats definitive provider outcomes as terminal", () => {
  assert.equal(classifyOmniReconciliationResult({ status: "failed" }), "failed");
  assert.equal(
    classifyOmniReconciliationResult({ status: "succeeded", videoBase64: "AAAA" }),
    "succeeded"
  );
  for (const result of [
    { status: "running" },
    { status: "queued" },
    { status: "succeeded" },
    undefined,
  ]) {
    assert.equal(classifyOmniReconciliationResult(result), "pending");
  }
});
