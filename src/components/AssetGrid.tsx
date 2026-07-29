"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
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
 * everything the user had already scrolled past.
 *
 * Layout is masonry again — but packed in JS by `packColumns`, not by CSS.
 * The intermediate version here was a uniform CSS grid, which fixed the
 * reshuffle (a fixed track is append-stable by construction) at the cost of
 * ragged dead space: a grid row is as tall as its tallest card, so a 9:16
 * portrait left a visible band of nothing under the 21:9 beside it. Greedy
 * shortest-column packing gets both properties — it fills the gaps AND depends
 * only on the items before each card, so appending cannot move what is already
 * placed. See packColumns.
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

  // Column count is derived from the measured scroller, not from a CSS
  // `auto-fill` track, because the packing below has to know it too — and the
  // two must agree exactly or cards would be laid out against a different
  // column count than they were assigned to.
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const columns = useMemo(
    () => packColumns(items, width, cardWidth),
    [items, width, cardWidth]
  );

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
    // `h-full` AND `flex-1`, deliberately. In HistoryPanel the parent is a flex
    // column, so flex-1 is what sizes this; in ProjectPanel it is a stretched
    // flex ITEM of a row, where flex-1 means nothing and h-full is what works.
    // Carrying only flex-1 left this box at height:auto under ProjectPanel, so
    // the scroller below (h-full of an auto height => auto) grew with its
    // content instead of scrolling, and the asset list simply could not be
    // scrolled — visible only when the content overflowed, i.e. on some screen
    // sizes and not others.
    <div className="relative flex h-full min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="scroll-thin min-h-0 flex-1 overflow-y-auto px-4 py-4"
      >
        {loading ? (
          <SkeletonGrid cardWidth={cardWidth} />
        ) : items.length === 0 ? (
          <div className="h-[60vh]">{empty}</div>
        ) : (
          <>
            {/* Masonry columns, packed in JS. A uniform CSS grid made every row
                as tall as its tallest card, so a 9:16 portrait next to a 21:9
                still left a band of dead space under the short ones — very
                visible in a library that mixes those aspect ratios. */}
            <div className="flex items-start gap-3">
              {columns.map((column, ci) => (
                <div key={ci} className="flex min-w-0 flex-1 flex-col gap-3">
                  {/* No `mode="popLayout"`. popLayout takes exiting children
                      out of flow and animates their siblings into the gap,
                      which is the right effect for a small list and precisely
                      the wrong one for a grid being appended to while
                      scrolled. */}
                  <AnimatePresence initial={false}>
                    {column.map((item) => (
                      <div key={item.id}>{renderItem(item)}</div>
                    ))}
                  </AnimatePresence>
                </div>
              ))}
            </div>

            {/* Outside the columns: inside one it would lengthen that column
                and shift its packing every time it mounted or unmounted. */}
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

const GRID_GAP = 12; // matches gap-3

/** Relative height of a card, from its aspect ratio, in units of one column
 *  width. Only the ratio matters for packing, so no DOM measurement is needed —
 *  which is what keeps the layout deterministic and free of a measure/paint
 *  feedback loop. */
function relativeHeight(aspectRatio: string | undefined): number {
  const [w, h] = String(aspectRatio ?? "").split(":").map(Number);
  if (!w || !h || !Number.isFinite(w) || !Number.isFinite(h)) return 9 / 16;
  return h / w;
}

/**
 * Greedy shortest-column packing — masonry that cannot reshuffle.
 *
 * This is the specific property the previous CSS `columns` masonry lacked.
 * `column-fill: balance` equalises column heights across the WHOLE set, so
 * appending a page redistributed every card that was already on screen — the
 * reshuffle-while-scrolling this replaced. Here each item is placed, in order,
 * into whichever column is currently shortest, so a placement depends only on
 * the items *before* it. Appending items n+1… therefore cannot change where
 * items 1…n landed, and re-running the whole pack on every render reproduces
 * the identical prefix.
 *
 * (Re-packing does happen when the column count changes — a panel resize or a
 * zoom change — and when a new item is prepended. Both are direct consequences
 * of something the user just did, not movement under a passive scroll.)
 */
export function packColumns<T extends { id: string; aspectRatio?: string }>(
  items: T[],
  containerWidth: number,
  cardWidth: number
): T[][] {
  const count = columnCount(containerWidth, cardWidth);
  const columns: T[][] = Array.from({ length: count }, () => []);
  const heights = new Array(count).fill(0);

  for (const item of items) {
    let target = 0;
    for (let i = 1; i < count; i++) {
      // Strictly-less keeps ties going to the leftmost column, so the very
      // first row fills left-to-right the way reading order expects.
      if (heights[i] < heights[target]) target = i;
    }
    columns[target].push(item);
    heights[target] += relativeHeight(item.aspectRatio) + 0.06; // + gap
  }
  return columns;
}

/** How many cards fit across, honouring the zoom control's card width as a
 *  minimum. Mirrors what `repeat(auto-fill, minmax(cardWidth, 1fr))` would do. */
export function columnCount(containerWidth: number, cardWidth: number): number {
  // Before the first measurement, guess one column rather than zero: zero
  // columns would drop every item on the floor for a frame.
  if (!containerWidth) return 1;
  const usable = containerWidth - 32; // px-4 either side
  return Math.max(1, Math.floor((usable + GRID_GAP) / (cardWidth + GRID_GAP)));
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
