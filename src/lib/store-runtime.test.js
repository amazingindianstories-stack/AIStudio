import assert from "node:assert/strict";
import { test } from "vitest";
import {
  disposeStoreRuntime,
  nextStoreRequestSequence,
  setStoreTimeout,
  storeRuntime,
  storeRuntimeSnapshot,
} from "./store-runtime.js";

test("dispose clears polling, timers, and request counters for a later session", async () => {
  disposeStoreRuntime();
  storeRuntime.polling.add("video-1");
  storeRuntime.polling.add("depth-1");
  nextStoreRequestSequence("feed");
  nextStoreRequestSequence("counts");
  let staleTimerRan = false;
  setStoreTimeout(() => { staleTimerRan = true; }, 20);

  disposeStoreRuntime();
  assert.deepEqual(storeRuntimeSnapshot(), {
    pollingIds: [],
    timerCount: 0,
    sequences: { feed: 0, counts: 0, thread: 0 },
    liveRunning: false,
  });
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(staleTimerRan, false);

  assert.match(nextStoreRequestSequence("feed"), /:1$/);
  let nextSessionRan = false;
  setStoreTimeout(() => { nextSessionRan = true; }, 0);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(nextSessionRan, true);
  assert.equal(storeRuntimeSnapshot().timerCount, 0);
  disposeStoreRuntime();
});
