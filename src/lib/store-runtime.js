/**
 * Process-scoped coordination for the client store.
 *
 * These values intentionally do not live in Zustand: timer handles, active
 * poll IDs, and request sequence counters coordinate side effects but are
 * never rendered UI state. Keeping them here also gives logout, teardown, and
 * isolated tests one deterministic disposal boundary.
 */
export const storeRuntime = {
  polling: new Set(),
  timers: new Set(),
  epoch: 0,
  sequences: { feed: 0, counts: 0, thread: 0 },
  liveTimer: null,
  liveSince: 0,
  liveRunning: false,
  liveVisibilityHandler: null,
  scopeTimer: null,
  promptTimer: null,
  refsTimer: null,
  lastScopeKey: null,
};

export function nextStoreRequestSequence(kind) {
  storeRuntime.sequences[kind] += 1;
  return `${storeRuntime.epoch}:${storeRuntime.sequences[kind]}`;
}

export function currentStoreRequestSequence(kind) {
  return `${storeRuntime.epoch}:${storeRuntime.sequences[kind]}`;
}

export function setStoreTimeout(callback, delay) {
  let timer;
  timer = setTimeout(() => {
    storeRuntime.timers.delete(timer);
    callback();
  }, delay);
  storeRuntime.timers.add(timer);
  return timer;
}

export function clearStoreTimeout(timer) {
  if (timer == null) return null;
  clearTimeout(timer);
  storeRuntime.timers.delete(timer);
  return null;
}

/** Stop all process-level work without destroying the Zustand store itself. */
export function disposeStoreRuntime() {
  for (const timer of storeRuntime.timers) clearTimeout(timer);
  storeRuntime.timers.clear();
  storeRuntime.polling.clear();
  // Invalidates reads already in flight before counters restart at zero, so a
  // late response from the prior session cannot share a sequence with the
  // first request in the next session.
  storeRuntime.epoch += 1;
  storeRuntime.sequences.feed = 0;
  storeRuntime.sequences.counts = 0;
  storeRuntime.sequences.thread = 0;
  storeRuntime.liveTimer = null;
  storeRuntime.liveSince = 0;
  storeRuntime.liveRunning = false;
  storeRuntime.scopeTimer = null;
  storeRuntime.promptTimer = null;
  storeRuntime.refsTimer = null;
  storeRuntime.lastScopeKey = null;
  if (typeof document !== "undefined" && storeRuntime.liveVisibilityHandler) {
    document.removeEventListener("visibilitychange", storeRuntime.liveVisibilityHandler);
  }
  storeRuntime.liveVisibilityHandler = null;
}

export function storeRuntimeSnapshot() {
  return {
    pollingIds: [...storeRuntime.polling],
    timerCount: storeRuntime.timers.size,
    sequences: { ...storeRuntime.sequences },
    liveRunning: storeRuntime.liveRunning,
  };
}
