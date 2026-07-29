"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { historyFilterToParams } from "./history-query";
import { HISTORY_PAGE_SIZE } from "./config";
import type { GenerationItem, GenerationKind } from "./types";

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
 * Kept deliberately small: no cache, no mutation handling. It is a read of a
 * filtered list. Rows the user mutates (favourite, delete) still flow through
 * the store, and this hook refetches when its scope changes.
 */
export interface HistoryQueryScope {
  projectId?: string;
  kind?: "all" | GenerationKind;
  favorite?: boolean;
  q?: string;
  /** Set false to hold the query (e.g. while a panel is collapsed). */
  enabled?: boolean;
}

export function useHistoryQuery(scope: HistoryQueryScope) {
  const { projectId, kind = "all", favorite = false, q = "", enabled = true } = scope;

  const [items, setItems] = useState<GenerationItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  // Same stale-response guard as the store: a scope change mid-flight must not
  // let the older reply paint over the newer one.
  const seqRef = useRef(0);
  const cursorRef = useRef<string | null>(null);

  const key = `${projectId ?? "*"}|${kind}|${favorite ? 1 : 0}|${q.trim().toLowerCase()}`;

  useEffect(() => {
    if (!enabled) return;
    const seq = ++seqRef.current;
    setLoading(true);

    // Search is a database query now, so debounce it rather than firing one
    // request per keystroke.
    const timer = setTimeout(async () => {
      try {
        const params = historyFilterToParams({ projectId, kind, favorite, q });
        params.set("limit", String(HISTORY_PAGE_SIZE));
        const res = await fetch(`/api/history?${params}`, { cache: "no-store" });
        const json = await res.json();
        if (seq !== seqRef.current) return;
        setItems(json.items ?? []);
        cursorRef.current = json.nextCursor ?? null;
        setNextCursor(json.nextCursor ?? null);
      } catch {
        if (seq !== seqRef.current) return;
        setItems([]);
        cursorRef.current = null;
        setNextCursor(null);
      } finally {
        if (seq === seqRef.current) setLoading(false);
      }
    }, q ? 300 : 0);

    return () => clearTimeout(timer);
    // `key` collapses the scope into one dependency; the individual values are
    // read inside and are consistent with it by construction.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled]);

  const loadMore = useCallback(async () => {
    const cursor = cursorRef.current;
    if (!cursor || loadingMore) return;
    const seq = seqRef.current;
    setLoadingMore(true);
    try {
      const params = historyFilterToParams({ projectId, kind, favorite, q });
      params.set("limit", String(HISTORY_PAGE_SIZE));
      params.set("cursor", cursor);
      const res = await fetch(`/api/history?${params}`, { cache: "no-store" });
      const json = await res.json();
      if (seq !== seqRef.current) return;
      const incoming: GenerationItem[] = json.items ?? [];
      setItems((prev) => {
        const seen = new Set(prev.map((i) => i.id));
        return [...prev, ...incoming.filter((i) => !seen.has(i.id))];
      });
      cursorRef.current = json.nextCursor ?? null;
      setNextCursor(json.nextCursor ?? null);
    } catch {
      /* the sentinel stays visible; scrolling retries */
    } finally {
      if (seq === seqRef.current) setLoadingMore(false);
    }
  }, [projectId, kind, favorite, q, loadingMore]);

  return { items, loading, loadingMore, hasMore: nextCursor !== null, loadMore };
}
