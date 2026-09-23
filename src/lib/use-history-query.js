"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { historyFilterToParams } from "./history-query";
import { HISTORY_PAGE_SIZE } from "./config";
import { apiFetch } from "./api";
import {
  dedupeFirstPage,
  getCached,
  isFeedFresh,
  putFeedCache,
} from "./feed-cache";
import { scopeKey } from "./feed-scope";

/**
 * A standalone paginated read of the library, for surfaces that need their own
 * scope rather than the right panel's.
 *
 * The canvas asset panel is the case this exists for: it has its own project
 * scope, tab and search, and it used to satisfy them by filtering the global
 * store's `items` array. That inherited every problem of the old design — the
 * pool was whatever the right panel happened to have paged in, so scoping the
 * canvas panel to an older project showed nothing until the user had scrolled
 * an unrelated panel far enough back — and it would now also fight the store's
 * scope for control of the same array.
 *
 * Uses the same bounded metadata cache as the main library, so Canvas and
 * Studio can share first pages and mutation propagation.
 */

export function useHistoryQuery(scope) {
  const { projectId, kind = "all", favorite = false, q = "", enabled = true } = scope;

  const [items, setItems] = useState([]);
  const [nextCursor, setNextCursor] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [paginationError, setPaginationError] = useState(null);
  const [retryToken, setRetryToken] = useState(0);

  // Same stale-response guard as the store: a scope change mid-flight must not
  // let the older reply paint over the newer one.
  const seqRef = useRef(0);
  const cursorRef = useRef(null);

  const key = scopeKey({
    tab: favorite ? "favorites" : projectId ? "project" : "history",
    projectId,
    folderId: null,
    kind,
    q,
  });

  useEffect(() => {
    if (!enabled) return;
    const seq = ++seqRef.current;
    const cached = getCached(key);
    if (cached) {
      setItems(cached.items);
      cursorRef.current = cached.nextCursor;
      setNextCursor(cached.nextCursor);
      setLoading(false);
      setError(null);
      if (isFeedFresh(cached)) return;
      setRefreshing(true);
    } else {
      setLoading(true);
      setItems([]);
      setNextCursor(null);
      cursorRef.current = null;
    }

    // Search is a database query now, so debounce it rather than firing one
    // request per keystroke.
    const timer = setTimeout(async () => {
      try {
        const params = historyFilterToParams({ projectId, kind, favorite, q });
        params.set("limit", String(HISTORY_PAGE_SIZE));
        const json = await dedupeFirstPage(key, async () => {
          const res = await apiFetch(`/api/history?${params}`, { cache: "no-store" });
          if (!res.ok) throw new Error(`History request failed (${res.status})`);
          return res.json();
        });
        if (seq !== seqRef.current) return;
        const nextItems = json.items ?? [];
        putFeedCache(key, { items: nextItems, nextCursor: json.nextCursor ?? null, at: Date.now() });
        setItems(nextItems);
        cursorRef.current = json.nextCursor ?? null;
        setNextCursor(json.nextCursor ?? null);
        setError(null);
      } catch (cause) {
        if (seq !== seqRef.current) return;
        setError(cause?.message || "Could not load assets.");
      } finally {
        if (seq === seqRef.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    }, q ? 300 : 0);

    return () => clearTimeout(timer);
    // `key` collapses the scope into one dependency; the individual values are
    // read inside and are consistent with it by construction.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled, retryToken]);

  const loadMore = useCallback(async () => {
    const cursor = cursorRef.current;
    if (!cursor || loadingMore) return;
    const seq = seqRef.current;
    setLoadingMore(true);
    setPaginationError(null);
    try {
      const params = historyFilterToParams({ projectId, kind, favorite, q });
      params.set("limit", String(HISTORY_PAGE_SIZE));
      params.set("cursor", cursor);
      const res = await apiFetch(`/api/history?${params}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`History request failed (${res.status})`);
      const json = await res.json();
      if (seq !== seqRef.current) return;
      const incoming = json.items ?? [];
      setItems((prev) => {
        const seen = new Set(prev.map((i) => i.id));
        const appended = [...prev, ...incoming.filter((i) => !seen.has(i.id))];
        putFeedCache(key, { items: appended, nextCursor: json.nextCursor ?? null, at: Date.now() });
        return appended;
      });
      cursorRef.current = json.nextCursor ?? null;
      setNextCursor(json.nextCursor ?? null);
    } catch (cause) {
      if (seq === seqRef.current) setPaginationError(cause?.message || "Could not load more assets.");
    } finally {
      if (seq === seqRef.current) setLoadingMore(false);
    }
  }, [projectId, kind, favorite, q, loadingMore, key]);

  return {
    items, loading, refreshing, loadingMore, error, paginationError,
    hasMore: nextCursor !== null,
    loadMore,
    retry: () => setRetryToken((value) => value + 1),
  };
}
