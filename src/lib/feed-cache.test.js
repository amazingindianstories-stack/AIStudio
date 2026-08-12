import test from "node:test";
import assert from "node:assert/strict";
import {
  FEED_CACHE_MAX,
  clearFeedCache,
  dropCached,
  feedCacheKeys,
  getCached,
  patchCached,
  putFeedCache,
  writeCachedItems,
} from "./feed-cache";

/**
 * These exist because of a real production hang.
 *
 * `patchCached` originally iterated the cache Map while calling `putFeedCache`,
 * which deletes a key and re-inserts it to maintain LRU order. A JS Map
 * iterator visits entries added during iteration, so it reached the same key
 * again — delete, re-append, revisit — with no termination. It ran on every
 * poll tick of an in-flight generation, so the whole app locked up seconds
 * after pressing Generate.
 *
 * Every test here has a hard timeout: an infinite loop must fail the run rather
 * than hang it.
 */

const item = (id, patch = {}) => ({
  id,
  kind: "image",
  status: "succeeded",
  prompt: "p",
  model: "Nano Banana Pro",
  aspectRatio: "16:9",
  createdAt: 1,
  updatedAt: 1,
  ...patch,
});

function seed(keys, withId) {
  clearFeedCache();
  for (const k of keys) {
    putFeedCache(k, { items: [item(withId), item(`${k}-other`)], nextCursor: null, at: 1 });
  }
}

test("patchCached terminates across many cached scopes", { timeout: 5000 }, () => {
  // The original bug: this never returned.
  seed(["a", "b", "c", "d", "e"], "shared");
  patchCached("shared", (i) => ({ ...i, isFavorite: true }));
  for (const k of ["a", "b", "c", "d", "e"]) {
    const row = getCached(k).items.find((i) => i.id === "shared");
    assert.equal(row.isFavorite, true, `scope ${k} was not patched`);
  }
});

test("dropCached terminates across many cached scopes", { timeout: 5000 }, () => {
  seed(["a", "b", "c", "d", "e"], "doomed");
  dropCached("doomed");
  for (const k of ["a", "b", "c", "d", "e"]) {
    assert.equal(getCached(k).items.some((i) => i.id === "doomed"), false);
  }
});

test("patchCached does not reorder the LRU", { timeout: 5000 }, () => {
  // A background poll updating a row must not promote some other scope's
  // recency — and preserving order is also what makes the loop terminate.
  seed(["a", "b", "c"], "shared");
  patchCached("shared", (i) => ({ ...i, isFavorite: true }));
  assert.deepEqual(feedCacheKeys(), ["a", "b", "c"]);
});

test("patchCached leaves scopes without the row untouched", { timeout: 5000 }, () => {
  clearFeedCache();
  putFeedCache("has", { items: [item("x")], nextCursor: "cur", at: 1 });
  putFeedCache("hasnt", { items: [item("y")], nextCursor: "cur2", at: 1 });
  const before = getCached("hasnt");
  patchCached("x", (i) => ({ ...i, isFavorite: true }));
  assert.equal(getCached("hasnt"), before, "untouched scope was rewritten");
});

test("patchCached preserves each scope's pagination cursor", { timeout: 5000 }, () => {
  clearFeedCache();
  putFeedCache("a", { items: [item("x")], nextCursor: "CURSOR", at: 7 });
  patchCached("x", (i) => ({ ...i, isFavorite: true }));
  assert.equal(getCached("a").nextCursor, "CURSOR");
  assert.equal(getCached("a").at, 7);
});

test("putFeedCache promotes an existing key to most-recent", { timeout: 5000 }, () => {
  clearFeedCache();
  for (const k of ["a", "b", "c"]) {
    putFeedCache(k, { items: [], nextCursor: null, at: 1 });
  }
  putFeedCache("a", { items: [], nextCursor: null, at: 2 });
  assert.deepEqual(feedCacheKeys(), ["b", "c", "a"]);
});

test("eviction drops the least-recently-used, never the just-written key", { timeout: 5000 }, () => {
  clearFeedCache();
  for (let i = 0; i < FEED_CACHE_MAX + 5; i++) {
    putFeedCache(`k${i}`, { items: [], nextCursor: null, at: 1 });
  }
  const keys = feedCacheKeys();
  assert.equal(keys.length, FEED_CACHE_MAX);
  assert.equal(keys[keys.length - 1], `k${FEED_CACHE_MAX + 4}`);
  assert.equal(getCached("k0"), undefined, "oldest should have been evicted");
});

test("writeCachedItems is a no-op for an unknown scope", { timeout: 5000 }, () => {
  // Creating an entry here would invent nextCursor:null, and the next visit
  // would serve that as a complete page — an infinite scroll that stops after
  // one row.
  clearFeedCache();
  writeCachedItems("never-fetched", [item("x")]);
  assert.equal(getCached("never-fetched"), undefined);
  assert.deepEqual(feedCacheKeys(), []);
});

test("writeCachedItems keeps the cursor and replaces the rows", { timeout: 5000 }, () => {
  clearFeedCache();
  putFeedCache("a", { items: [item("x")], nextCursor: "CUR", at: 1 });
  writeCachedItems("a", [item("y"), item("z")]);
  assert.deepEqual(getCached("a").items.map((i) => i.id), ["y", "z"]);
  assert.equal(getCached("a").nextCursor, "CUR");
});

test("a patch applied repeatedly, as a poll would, stays bounded", { timeout: 5000 }, () => {
  // Mimics the actual failure shape: many ticks against many scopes.
  seed(["a", "b", "c", "d"], "live");
  for (let tick = 0; tick < 200; tick++) {
    patchCached("live", (i) => ({ ...i, updatedAt: tick }));
  }
  assert.equal(feedCacheKeys().length, 4);
  assert.equal(getCached("a").items.find((i) => i.id === "live").updatedAt, 199);
});
