"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowUp, Loader2 } from "lucide-react";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import type { GenerationItem } from "@/lib/types";

/**
 * The one scrolling asset grid, shared by the project view and the global
 * library views.
 *
 * It exists because those two used to render the same rows through two
 * different layouts, and the project one was a balanced CSS multi-column
 * masonry (`columns-… [column-fill:_balance]`). Column balancing is a global
 * calculation: appending a page of results re-distributes *every* card across
 * the columns, so each turn of the infinite scroll visibly reshuffled
 * everything the user had already scrolled past. A CSS grid with a fixed track
 * definition is append-stable by construction — card N's position never depends
 * on card N+1's existence — which is the property the masonry could not have.
 *
 * Three further sources of movement are handled here rather than in the store:
 *  - `overflow-anchor` is left at its default so the browser pins the scroll
 *    position against content changes above the viewport.
 *  - The infinite-scroll sentinel sits in its own row below the grid, so it
 *    cannot claim a grid cell and reflow the last row when it appears.
 *  - New live arrivals are buffered by the store while the user is scrolled
 *    away from the top and surfaced as the pill below; inserting them silently
 *    would push everything down mid-read.
 */
export function AssetGrid({
  items,
  loading,
  cardWidth,
  empty,
  renderItem,
}: {
  items: GenerationItem[];
  loading: boolean;
  cardWidth: number;
  empty: ReactNode;
  renderItem: (item: GenerationItem) => ReactNode;
}) {
  const feedKey = useStore((s) => s.feedKey);
  const hasMoreHistory = useStore((s) => s.hasMoreHistory);
  const loadMoreHistory = useStore((s) => s.loadMoreHistory);
  const pendingCount = useStore((s) => s.pendingItems.length);
  const flushPendingItems = useStore((s) => s.flushPendingItems);
  const setFeedPinned = useStore((s) => s.setFeedPinned);

  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const [isLoadingMore, setIsLoadingMore] = useState(false);

  // Tell the store whether an insert at the head would be visible or would
  // shove the viewport. `pinned` is deliberately a small band rather than
  // exactly zero: a couple of pixels of momentum should not count as "the user
  // has scrolled away".
  const PIN_THRESHOLD_PX = 48;
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setFeedPinned(el.scrollTop <= PIN_THRESHOLD_PX);
  }, [setFeedPinned]);

  // A new scope starts at the top. Keyed on the scope's identity rather than on
  // `loading`, because a cached scope is served without ever entering a loading
  // state — keying on `loading` would leave the new folder opened at the
  // previous one's scroll offset. Appending a page changes `items` but not
  // `feedKey`, so paging never yanks the user back to the top.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = 0;
    setFeedPinned(true);
  }, [feedKey, setFeedPinned]);

  useEffect(() => {
    const target = sentinelRef.current;
    if (!target) return;
    const observer = new IntersectionObserver(
      async (entries) => {
        if (!entries[0].isIntersecting) return;
        if (!hasMoreHistory || isLoadingMore || loading) return;
        setIsLoadingMore(true);
        try {
          await loadMoreHistory();
        } finally {
          setIsLoadingMore(false);
        }
      },
      {
        // Start the next page before the sentinel is actually on screen, so
        // pages usually land during the scroll rather than after it stops.
        root: scrollRef.current,
        rootMargin: "600px 0px",
      }
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [hasMoreHistory, isLoadingMore, loading, loadMoreHistory, items.length]);

  const showPending = pendingCount > 0;

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="scroll-thin h-full overflow-y-auto px-4 py-4"
      >
        {loading ? (
          <SkeletonGrid cardWidth={cardWidth} />
        ) : items.length === 0 ? (
          <div className="h-[60vh]">{empty}</div>
        ) : (
          <>
            <div
              className="grid gap-3"
              style={{
                gridTemplateColumns: `repeat(auto-fill, minmax(${cardWidth}px, 1fr))`,
              }}
            >
              {/* No `mode="popLayout"`. popLayout takes exiting children out of
                  flow and animates their siblings into the gap, which is the
                  right effect for a small list and precisely the wrong one for
                  a grid that is being appended to while scrolled. */}
              <AnimatePresence initial={false}>
                {items.map((item) => (
                  <div key={item.id}>{renderItem(item)}</div>
                ))}
              </AnimatePresence>
            </div>

            {/* Outside the grid: as a grid child this would occupy a cell and
                shuffle the final row every time it mounted or unmounted. */}
            {hasMoreHistory && (
              <div
                ref={sentinelRef}
                className="flex h-16 w-full items-center justify-center text-xs text-white/35"
              >
                {isLoadingMore && (
                  <span className="flex items-center gap-2">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading more…
                  </span>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* Buffered arrivals. Offering them instead of inserting them is the
          difference between "the app told me there is something new" and "the
          thing I was looking at moved". */}
      <AnimatePresence>
        {showPending && (
          <motion.button
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            onClick={() => {
              flushPendingItems();
              scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
            }}
            className={cn(
              "absolute left-1/2 top-3 z-20 flex -translate-x-1/2 items-center gap-1.5",
              "rounded-full bg-brand px-3 py-1.5 text-xs font-semibold text-ink-900 shadow-pop",
              "transition hover:brightness-110"
            )}
          >
            <ArrowUp className="h-3.5 w-3.5" />
            {pendingCount} new {pendingCount === 1 ? "item" : "items"}
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  );
}

/** Skeleton tiles on the same track definition as the real grid, so the
 *  transition from loading to loaded does not change the column count. */
export function SkeletonGrid({ cardWidth }: { cardWidth: number }) {
  return (
    <div
      className="grid gap-3"
      style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${cardWidth}px, 1fr))` }}
    >
      {[180, 240, 200, 280, 160, 220, 260, 190, 210, 250, 175, 230].map((h, i) => (
        <div key={i} className="skeleton rounded-xl" style={{ height: h }} />
      ))}
    </div>
  );
}
