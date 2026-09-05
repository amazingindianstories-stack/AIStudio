import assert from "node:assert/strict";
import { test } from "vitest";
import { costBasisForGeneration } from "./cost-basis.js";

test("an explicitly reconciled row remains reconciled", () => {
  assert.equal(costBasisForGeneration({ costBasis: "reconciled" }), "reconciled");
});

test("missing, unknown, and legacy values conservatively remain estimates", () => {
  for (const costBasis of [undefined, null, "", "actual", "unknown"]) {
    assert.equal(costBasisForGeneration({ costBasis }), "estimated");
  }
});
