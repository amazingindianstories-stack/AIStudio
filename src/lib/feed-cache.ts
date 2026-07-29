import type { GenerationItem } from "./types";

/**
 * LRU cache of library feeds, keyed by scope.
 *
 * Extracted from store.ts so the mutation helpers can be unit-tested. They
 * needed to be: the first version iterated the Map while re-inserting into it,
 * which hung the browser (see `patchCached`).
 */

export interface CachedFeed {
  items: GenerationItem[];
  nextCursor: string | null;
  /** When it was fetched — drives background revalidation on re-entry. */
  at: number;
}

/** LRU bound. Feeds are ~20 rows of metadata, but a user clicking through many
 *  folders would otherwise accumulate them for the life of the tab. */
export const FEED_CACHE_MAX = 24;

const cache = new Map<string, CachedFeed>();

export function getCached(key: string): CachedFeed | undefined {
  return cache.get(key);
}

export function clearFeedCache() {
  cache.clear();
}

/** Test/diagnostic accessor. */
export function feedCacheKeys(): string[] {
  return Array.from(cache.keys());
}

/**
 * Store a scope as the most-recently-used entry.
 *
 * The delete-then-set is what makes eviction true LRU rather than
 * first-in-first-out: `Map.set` on an existing key does NOT move it, so without
 * the delete the scope the user is actually sitting in could age out from
 * under them.
 *
 * ⚠ Precisely because it reorders, this must NEVER be called while iterating
 * the cache — see `patchCached`.
 */
export function putFeedCache(key: string, value: CachedFeed) {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > FEED_CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined || oldest === key) break;
    cache.delete(oldest);
  }
}

/**
 * Replace a cached scope's rows, keeping its pagination cursor and its position
 * in the LRU order.
 *
 * A no-op when the scope has never been fetched: creating an entry here would
 * invent `nextCursor: null` for it, and the next visit would serve that as a
 * complete, fresh page — an infinite scroll that stops after whatever single
 * row a live update happened to put there.
 */
export function writeCachedItems(key: string, items: GenerationItem[]) {
  const cached = cache.get(key);
  if (!cached) return;
  putFeedCache(key, { ...cached, items });
}

/**
 * Apply a patch to one row across every cached scope.
 *
 * Iterates a SNAPSHOT of the keys and writes with a plain `Map.set`, which
 * leaves insertion order untouched.
 *
 * The first version did `for (const [key, cached] of cache) putFeedCache(...)`,
 * and that hung the tab: `putFeedCache` deletes the key and re-inserts it at
 * the end, a Map iterator visits entries added during iteration, so it reached
 * the same key again — delete, re-append, revisit — forever. Since this runs on
 * every poll tick of an in-flight generation, the symptom was the whole app
 * locking up shortly after pressing Generate.
 *
 * Patching is also not a "use" for LRU purposes — a background poll updating a
 * row should not promote some other scope's recency — so preserving order is
 * correct on its own terms, not merely a workaround.
 */
export function patchCached(
  id: string,
  patch: (item: GenerationItem) => GenerationItem
) {
  for (const key of Array.from(cache.keys())) {
    const cached = cache.get(key);
    if (!cached || !cached.items.some((i) => i.id === id)) continue;
    cache.set(key, {
      ...cached,
      items: cached.items.map((i) => (i.id === id ? patch(i) : i)),
    });
  }
}

/** Remove a row from every cached scope. Same snapshot-and-plain-set rule as
 *  `patchCached`, for the same reason. */
export function dropCached(id: string) {
  for (const key of Array.from(cache.keys())) {
    const cached = cache.get(key);
    if (!cached || !cached.items.some((i) => i.id === id)) continue;
    cache.set(key, {
      ...cached,
      items: cached.items.filter((i) => i.id !== id),
    });
  }
}
