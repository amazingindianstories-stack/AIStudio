import { test } from "node:test";
import assert from "node:assert/strict";
import { AUTO_FIT_MIN, autoFitMax, largestFitting } from "./use-auto-fit";

test("largestFitting finds the largest size that fits", () => {
  assert.equal(largestFitting((px) => px <= 37, AUTO_FIT_MIN, 66), 37);
  assert.equal(largestFitting(() => true, AUTO_FIT_MIN, 66), 66);
  assert.equal(largestFitting(() => false, AUTO_FIT_MIN, 66), AUTO_FIT_MIN);
  assert.equal(largestFitting(() => true, AUTO_FIT_MIN, 4), AUTO_FIT_MIN);
});

test("largestFitting measures only a handful of sizes", () => {
  let calls = 0;
  largestFitting((px) => (calls++, px <= 20), AUTO_FIT_MIN, 200);
  assert.ok(calls <= 8, `measured ${calls} times`);
});

test("the auto size tops out at a third of the shorter side", () => {
  assert.equal(autoFitMax(200, 200), 66);
  assert.equal(autoFitMax(350, 228), 76);
  assert.equal(autoFitMax(10, 10), AUTO_FIT_MIN);
});
