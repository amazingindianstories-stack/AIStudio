import assert from "node:assert/strict";
import { beforeEach, test } from "vitest";
import {
  patchEverywhere,
  dropEverywhere,
  findItem,
  mergeLiveItems,
  adoptOrphanedJobs,
  polling,
} from "./store";
import { clearFeedCache, getCached, putFeedCache } from "./feed-cache";

/**
 * Tests for store.js's pool-management helpers — patchEverywhere,
 * dropEverywhere, findItem, mergeLiveItems, adoptOrphanedJobs — previously
 * the largest untested module in the frontend. Exported solely for this file
 * (see the doc comment on patchEverywhere in store.js); every real caller
 * goes through the store's own actions.
 *
 * A minimal fake set/get pair stands in for Zustand's create(): these
 * helpers only ever call `set` with the same `(partial | updater) => void`
 * signature Zustand itself exposes, so exercising them doesn't require the
 * real store — and using a fake one keeps these tests from touching the
 * actual shared `useStore` singleton the rest of the app also reaches for.
 */
function harness(overrides = {}) {
  let state = {
    items: [],
    threadItems: [],
    pendingItems: [],
    rightTab: "history",
    activeProjectId: null,
    activeFolderId: null,
    filterKind: "all",
    search: "",
    feedPinned: true,
    ...overrides,
  };
  const get = () => state;
  const set = (updater) => {
    const patch = typeof updater === "function" ? updater(state) : updater;
    state = { ...state, ...patch };
  };
  return { get, set, state: () => state };
}

function makeItem(overrides = {}) {
  return {
    id: "a",
    kind: "image",
    status: "succeeded",
    prompt: "a cat",
    createdAt: 1000,
    updatedAt: 1000,
    isFavorite: false,
    ...overrides,
  };
}

beforeEach(() => {
  clearFeedCache();
});

// ── findItem ─────────────────────────────────────────────────────────────

test("findItem: finds a row in items", () => {
  const item = makeItem({ id: "x" });
  const h = harness({ items: [item] });
  assert.equal(findItem(h.state(), "x"), item);
});

test("findItem: falls back to threadItems, then pendingItems — a row the user clicked may live in either pool without being in the current feed", () => {
  const inThread = makeItem({ id: "t" });
  const inPending = makeItem({ id: "p" });
  const h = harness({ threadItems: [inThread], pendingItems: [inPending] });
  assert.equal(findItem(h.state(), "t"), inThread);
  assert.equal(findItem(h.state(), "p"), inPending);
});

test("findItem: returns undefined when the row is in no pool", () => {
  const h = harness();
  assert.equal(findItem(h.state(), "missing"), undefined);
});

// ── patchEverywhere ──────────────────────────────────────────────────────

test("patchEverywhere: patches the row in every pool that holds it", () => {
  const item = makeItem({ id: "a", isFavorite: false });
  const h = harness({ items: [item], threadItems: [item], pendingItems: [item] });
  patchEverywhere(h.set, "a", (i) => ({ ...i, isFavorite: true }));
  assert.equal(h.state().items[0].isFavorite, true);
  assert.equal(h.state().threadItems[0].isFavorite, true);
  assert.equal(h.state().pendingItems[0].isFavorite, true);
});

test("patchEverywhere: leaves rows with a different id untouched", () => {
  const a = makeItem({ id: "a" });
  const b = makeItem({ id: "b", prompt: "unchanged" });
  const h = harness({ items: [a, b] });
  patchEverywhere(h.set, "a", (i) => ({ ...i, prompt: "changed" }));
  assert.equal(h.state().items[1].prompt, "unchanged");
});

test("patchEverywhere: also patches every cached scope holding the row — a favourite toggle must survive a tab switch back to a stale cache entry", () => {
  const item = makeItem({ id: "a", isFavorite: false });
  putFeedCache("scope-1", { items: [item], nextCursor: null, at: 0 });
  const h = harness();
  patchEverywhere(h.set, "a", (i) => ({ ...i, isFavorite: true }));
  assert.equal(getCached("scope-1").items[0].isFavorite, true);
});

// ── dropEverywhere ───────────────────────────────────────────────────────

test("dropEverywhere: removes the row from every pool", () => {
  const item = makeItem({ id: "a" });
  const other = makeItem({ id: "b" });
  const h = harness({ items: [item, other], threadItems: [item], pendingItems: [item] });
  dropEverywhere(h.set, "a");
  assert.deepEqual(h.state().items, [other]);
  assert.deepEqual(h.state().threadItems, []);
  assert.deepEqual(h.state().pendingItems, []);
});

test("dropEverywhere: also drops the row from every cached scope", () => {
  const item = makeItem({ id: "a" });
  putFeedCache("scope-1", { items: [item], nextCursor: null, at: 0 });
  const h = harness();
  dropEverywhere(h.set, "a");
  assert.deepEqual(getCached("scope-1").items, []);
});

// ── mergeLiveItems ───────────────────────────────────────────────────────

test("mergeLiveItems: a strictly-newer incoming row overwrites the existing one", () => {
  const cur = makeItem({ id: "a", updatedAt: 100, prompt: "old" });
  const inc = makeItem({ id: "a", updatedAt: 200, prompt: "new" });
  const h = harness({ items: [cur] });
  mergeLiveItems([inc], h.set);
  assert.equal(h.state().items[0].prompt, "new");
});

test("mergeLiveItems: an incoming row that is not strictly newer is ignored, so a slow live poll can't clobber a fresher local write", () => {
  const cur = makeItem({ id: "a", updatedAt: 200, prompt: "fresh" });
  const inc = makeItem({ id: "a", updatedAt: 100, prompt: "stale" });
  const h = harness({ items: [cur] });
  mergeLiveItems([inc], h.set);
  assert.equal(h.state().items[0].prompt, "fresh");
});

test("mergeLiveItems: queueNote is dropped once the item leaves the queue", () => {
  const cur = makeItem({ id: "a", status: "queued", updatedAt: 100, queueNote: "waiting" });
  const inc = makeItem({ id: "a", status: "running", updatedAt: 200 });
  const h = harness({ items: [cur] });
  mergeLiveItems([inc], h.set);
  assert.equal(h.state().items[0].queueNote, undefined);
});

test("mergeLiveItems: an update that moves a row out of scope removes it rather than showing something a refetch would immediately drop", () => {
  const cur = makeItem({ id: "a", updatedAt: 100, kind: "image" });
  const inc = makeItem({ id: "a", updatedAt: 200, kind: "video" });
  const h = harness({ items: [cur], filterKind: "image" });
  mergeLiveItems([inc], h.set);
  assert.equal(h.state().items.length, 0);
});

test("mergeLiveItems: a new in-flight row is inserted even if older than the oldest loaded page", () => {
  const loaded = makeItem({ id: "old", createdAt: 5000 });
  const inc = makeItem({ id: "new", createdAt: 1, status: "running" });
  const h = harness({ items: [loaded], feedPinned: true });
  mergeLiveItems([inc], h.set);
  assert.ok(h.state().items.some((i) => i.id === "new"));
});

test("mergeLiveItems: a new finished row older than the oldest loaded page is skipped — inserting it would open a pagination hole", () => {
  const loaded = makeItem({ id: "old", createdAt: 5000 });
  const inc = makeItem({ id: "new", createdAt: 1, status: "succeeded" });
  const h = harness({ items: [loaded], feedPinned: true });
  mergeLiveItems([inc], h.set);
  assert.ok(!h.state().items.some((i) => i.id === "new"));
});

test("mergeLiveItems: a new row is buffered into pendingItems when the user is scrolled away from the top, not spliced above the viewport", () => {
  const inc = makeItem({ id: "new", createdAt: 9999, status: "running" });
  const h = harness({ items: [], feedPinned: false });
  mergeLiveItems([inc], h.set);
  assert.equal(h.state().items.length, 0);
  assert.equal(h.state().pendingItems[0]?.id, "new");
});

test("mergeLiveItems: a row outside the current scope is ignored entirely, whether pinned or not", () => {
  const inc = makeItem({ id: "new", kind: "video", status: "running" });
  const h = harness({ items: [], filterKind: "image", feedPinned: false });
  mergeLiveItems([inc], h.set);
  assert.equal(h.state().items.length, 0);
  assert.equal(h.state().pendingItems.length, 0);
});

test("mergeLiveItems: an empty incoming list never calls set at all", () => {
  const h = harness({ items: [makeItem()] });
  let setCalls = 0;
  const countingSet = (u) => {
    setCalls++;
    h.set(u);
  };
  mergeLiveItems([], countingSet);
  assert.equal(setCalls, 0);
});

// ── adoptOrphanedJobs ────────────────────────────────────────────────────
// Adopting calls startPolling, which schedules a real setTimeout that would
// eventually reach the network. globalThis.setTimeout is stubbed for the
// duration of the call so adoption is observable (did it try to schedule a
// poll?) without ever touching the network or leaving a dangling timer
// behind. Everything through pollQueue's setTimeout(...) call is synchronous,
// so no await is needed around the stub.
function withStubbedTimeout(run) {
  const original = globalThis.setTimeout;
  let called = false;
  globalThis.setTimeout = () => {
    called = true;
    return 0;
  };
  try {
    run();
  } finally {
    globalThis.setTimeout = original;
  }
  return called;
}

test("adoptOrphanedJobs: adopts a queued job that has been stale long enough", () => {
  const item = makeItem({ id: "adopt-1", status: "queued", updatedAt: 0 });
  const h = harness();
  const scheduled = withStubbedTimeout(() => adoptOrphanedJobs([item], 60_000, h.set, h.get));
  assert.equal(scheduled, true);
});

test("adoptOrphanedJobs: leaves a recently-touched queued job alone — its own tab is presumed still driving it", () => {
  const item = makeItem({ id: "adopt-2", status: "queued", updatedAt: 59_000 });
  const h = harness();
  const scheduled = withStubbedTimeout(() => adoptOrphanedJobs([item], 60_000, h.set, h.get));
  assert.equal(scheduled, false);
});

test("adoptOrphanedJobs: never touches a running job — nothing here could resume it", () => {
  const item = makeItem({ id: "adopt-3", status: "running", updatedAt: 0 });
  const h = harness();
  const scheduled = withStubbedTimeout(() => adoptOrphanedJobs([item], 60_000, h.set, h.get));
  assert.equal(scheduled, false);
});

test("adoptOrphanedJobs: skips a job this tab is already polling, even if stale — no duplicate driver", () => {
  const item = makeItem({ id: "adopt-4", status: "queued", updatedAt: 0 });
  polling.add("adopt-4");
  try {
    const h = harness();
    const scheduled = withStubbedTimeout(() => adoptOrphanedJobs([item], 60_000, h.set, h.get));
    assert.equal(scheduled, false);
  } finally {
    polling.delete("adopt-4");
  }
});

test("adoptOrphanedJobs: falls back to the client clock when the server doesn't supply 'now'", () => {
  // updatedAt "just now" against a client-clock fallback should read as fresh,
  // not stale — this exercises the `typeof serverNow === "number"` branch
  // rather than asserting on a hardcoded threshold value.
  const item = makeItem({ id: "adopt-5", status: "queued", updatedAt: Date.now() });
  const h = harness();
  const scheduled = withStubbedTimeout(() => adoptOrphanedJobs([item], undefined, h.set, h.get));
  assert.equal(scheduled, false);
});
