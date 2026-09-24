import assert from "node:assert/strict";
import test from "node:test";
import { MAX_CONCURRENT, MAX_CONCURRENT_PER_USER } from "./queue-limits";

test("shared generation concurrency ceilings are explicit", () => {
  assert.deepEqual(MAX_CONCURRENT, { image: 10, video: 6 });
  assert.equal(MAX_CONCURRENT_PER_USER, 4);
});
