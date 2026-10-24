"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,

} from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowUp, Loader2 } from "lucide-react";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { useMarqueeSelection } from "@/lib/use-marquee-selection";
import { getNextGridFocus } from "@/lib/grid-navigation";
import { GENERATION_NAME_ROW_HEIGHT } from "./MediaCard";
import { libraryDateLabel, localDateKey } from "@/lib/library-filters";

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
  groupByDate,
}

) {
  const feedKey = useStore((s) => s.feedKey);
  const hasMoreHistory = useStore((s) => s.hasMoreHistory);
  const loadMoreHistory = useStore((s) => s.loadMoreHistory);
  const loadFeed = useStore((s) => s.loadFeed);
  const feedError = useStore((s) => s.feedError);
  const paginationError = useStore((s) => s.paginationError);
  const pendingCount = useStore((s) => s.pendingItems.length);
  const flushPendingItems = useStore((s) => s.flushPendingItems);
  const setFeedPinned = useStore((s) => s.setFeedPinned);
  const setGridColumns = useStore((s) => s.setGridColumns);
  const dateGrouping = useStore((s) => s.libraryGroupByDate);
  const sort = useStore((s) => s.librarySort);
  const tab = useStore((s) => s.rightTab);
  const now = useStore((s) => s.libraryDateNow);
  const grouped = (groupByDate ?? dateGrouping) && (sort || (tab === "favorites" ? "starred" : "newest")) !== "starred";

  const selectedIds = useStore((s) => s.selectedIds);
  const focusedAssetId = useStore((s) => s.focusedAssetId);
  const setSelectedIds = useStore((s) => s.setSelectedIds);
  const setFocusedAssetId = useStore((s) => s.setFocusedAssetId);
  const selectAll = useStore((s) => s.selectAll);
  const clearSelection = useStore((s) => s.clearSelection);
  const singleSelect = useStore((s) => s.singleSelect);
  const selectRange = useStore((s) => s.selectRange);
  const toggleSelect = useStore((s) => s.toggleSelect);
  const setActiveId = useStore((s) => s.setActiveId);

  const scrollRef = useRef(null);
  const sentinelRef = useRef(null);
  const [isLoadingMore, setIsLoadingMore] = useState(false);

  const marquee = useMarqueeSelection({
    scrollRef,
    getSelected: () => useStore.getState().selectedIds,
    setSelected: setSelectedIds,
    onClickBackground: clearSelection,
  });

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

  const layout = useMemo(
    () => packDateSections(items, width, cardWidth, grouped),
    // Midnight and timezone changes can change local date keys.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, width, cardWidth, grouped, now]
  );
  const columns = layout.columns;

  // Published so DetailModal's Up/Down arrow-key handling can walk visual
  // (same-column) neighbors instead of flat `items` order — those diverge as
  // soon as packColumns spreads items across more than one column, which is
  // the common case. Cleared on unmount so switching to a view with no grid
  // (e.g. a chat thread) doesn't leave the previous panel's layout active.
  useEffect(() => {
    setGridColumns(columns);
    return () => setGridColumns([]);
  }, [columns, setGridColumns]);

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

  const onKeyDown = (e) => {
    const target = e.target;
    if (
      target?.tagName === "INPUT" ||
      target?.tagName === "TEXTAREA" ||
      target?.isContentEditable
    ) {
      return;
    }

    const itemIds = items.map((i) => i.id);
    if (!itemIds.length) return;

    // Cmd/Ctrl + A: Select all
    if ((e.metaKey || e.ctrlKey) && (e.key === "a" || e.key === "A")) {
      e.preventDefault();
      selectAll(itemIds);
      return;
    }

    // Escape: Clear selection
    if (e.key === "Escape") {
      e.preventDefault();
      clearSelection();
      return;
    }

    // Space: Toggle focused asset
    if (e.key === " ") {
      if (focusedAssetId) {
        e.preventDefault();
        toggleSelect(focusedAssetId);
      }
      return;
    }

    // Enter: Open focused or first selected asset
    if (e.key === "Enter") {
      const toOpen = focusedAssetId || selectedIds[0];
      if (toOpen) {
        const it = items.find((x) => x.id === toOpen);
        if (it?.status === "succeeded") {
          e.preventDefault();
          setActiveId(toOpen);
        }
      }
      return;
    }

    // Quick focus search shortcut (/ or Cmd/Ctrl+F):
    if (
      (e.key === "/" && !e.metaKey && !e.ctrlKey) ||
      ((e.metaKey || e.ctrlKey) && (e.key === "f" || e.key === "F"))
    ) {
      const searchInput = document.querySelector('input[aria-label="Search prompts"]');
      if (searchInput) {
        e.preventDefault();
        searchInput.focus();
        searchInput.select?.();
        return;
      }
    }

    // Spatial Arrow Navigation
    let direction = null;
    if (e.key === "ArrowUp") direction = "up";
    else if (e.key === "ArrowDown") direction = "down";
    else if (e.key === "ArrowLeft") direction = "left";
    else if (e.key === "ArrowRight") direction = "right";
    else if (e.key === "Home") direction = "home";
    else if (e.key === "End") direction = "end";

    if (direction) {
      e.preventDefault();
      const currentId = focusedAssetId || selectedIds[0] || itemIds[0];
      const nextId = getNextGridFocus(columns, currentId, direction, items, { ...libraryCardSpacing(width, cardWidth), centers: layout.centers });
      if (nextId) {
        setFocusedAssetId(nextId);
        if (e.shiftKey) {
          selectRange(nextId, itemIds);
        } else {
          singleSelect(nextId);
        }

        const cardNode = scrollRef.current?.querySelector(`[data-asset-card-id="${nextId}"]`);
        if (cardNode) {
          cardNode.scrollIntoView({ block: "nearest", inline: "nearest" });
          cardNode.focus?.();
        }
      }
    }
  };

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
        // One callback can batch several entries for the sentinel (a layout
        // change and a scroll before delivery); only the newest is current,
        // and the observer will not fire again while that state holds.
        if (!entries.at(-1).isIntersecting) return;
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
    <div data-testid="asset-grid" className="relative flex h-full min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        tabIndex={-1}
        onScroll={onScroll}
        {...marquee.handlers}
        onKeyDown={onKeyDown}
        className={cn(
          "scroll-thin min-h-0 flex-1 overflow-y-auto px-4 py-4 relative outline-none",
          marquee.active && "select-none cursor-crosshair"
        )}
      >
        {marquee.active && (
          <div
            ref={marquee.overlayRef}
            data-testid="asset-grid-marquee"
            className="pointer-events-none absolute z-40 rounded border border-brand bg-brand/15 shadow-sm"
          />
        )}
        {loading ? (
          <SkeletonGrid cardWidth={cardWidth} />
        ) : feedError && items.length === 0 ? (
          <div role="alert" className="grid h-[60vh] place-items-center text-center text-sm text-white/55">
            <div><p>{feedError}</p><button onClick={() => loadFeed({ force: true })} className="mt-3 rounded-lg bg-white/10 px-3 py-1.5 font-medium text-white hover:bg-white/15">Retry</button></div>
          </div>
        ) : items.length === 0 ? (
          <div className="h-[60vh]">{empty}</div>
        ) : (
          <>
            {/* Masonry columns, packed in JS. A uniform CSS grid made every row
                as tall as its tallest card, so a 9:16 portrait next to a 21:9
                still left a band of dead space under the short ones — very
                visible in a library that mixes those aspect ratios. */}
            <div className={grouped ? "space-y-4" : undefined}>
              {layout.sections.map(section => <section key={section.key} aria-label={grouped ? libraryDateLabel(section.key, now) : undefined}>
                {grouped && <h3 className="mb-3 flex h-7 items-center gap-3 text-xs font-medium text-white/65 before:hidden after:h-px after:flex-1 after:bg-line">
                  {section.key === "unknown" ? "Date unavailable" : <time dateTime={section.key} title={section.key}>{libraryDateLabel(section.key, now)}</time>}
                </h3>}
                <div className="flex items-start gap-3">
              {section.columns.map((column, ci) => (
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
              </section>)}
            </div>

            {/* Outside the columns: inside one it would lengthen that column
                and shift its packing every time it mounted or unmounted. */}
            {hasMoreHistory && (
              <div
                ref={sentinelRef}
                className="flex h-16 w-full items-center justify-center text-xs text-white/35"
              >
                {isLoadingMore ? (
                  <span className="flex items-center gap-2">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading more…
                  </span>
                ) : paginationError ? (
                  <button onClick={() => loadMoreHistory()} className="rounded-lg px-3 py-2 text-white/65 underline hover:text-white">Retry loading more</button>
                ) : null}
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

/** Relative height of a card's media, from its aspect ratio, in units of one
 *  column width. Packing adds only the fixed name row and gap to it, so no DOM
 *  measurement is needed — which is what keeps the layout deterministic and
 *  free of a measure/paint feedback loop. */
function relativeHeight(aspectRatio) {
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
 * (Re-packing does happen when the container width changes — a panel resize,
 * a zoom change, or a classic scrollbar appearing — because the name row and
 * gap are measured against the resulting column width, and when a new item is
 * prepended. Each is a direct consequence of something the user did or a
 * one-time layout change, not movement under a passive scroll.)
 */
export function packColumns(
  items,
  containerWidth,
  cardWidth
) {
  const count = columnCount(containerWidth, cardWidth);
  const { below, gap } = libraryCardSpacing(containerWidth, cardWidth);
  const columns = Array.from({ length: count }, () => []);
  const heights = new Array(count).fill(0);

  for (const item of items) {
    let target = 0;
    for (let i = 1; i < count; i++) {
      // Strictly-less keeps ties going to the leftmost column, so the very
      // first row fills left-to-right the way reading order expects.
      if (heights[i] < heights[target]) target = i;
    }
    columns[target].push(item);
    heights[target] += relativeHeight(item.aspectRatio) + below + gap;
  }
  return columns;
}

/** Independent day packs, with complete columns and centers for keyboard/viewer navigation. */
export function packDateSections(items, containerWidth, cardWidth, grouped = true) {
  const groups = new Map();
  for (const item of items) {
    const key = grouped ? localDateKey(item.createdAt) : "all";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  const count = columnCount(containerWidth, cardWidth);
  const columnWidth = containerWidth ? (containerWidth - 32 - GRID_GAP * (count - 1)) / count : cardWidth;
  const spacing = libraryCardSpacing(containerWidth, cardWidth);
  const columns = Array.from({ length: count }, () => []), centers = {};
  let top = 0;
  const sections = [...groups].map(([key, rows]) => {
    const packed = packColumns(rows, containerWidth, cardWidth);
    if (grouped) top += 40 / columnWidth; // h-7 + mb-3
    let height = 0;
    packed.forEach((column, index) => {
      let offset = 0;
      for (const item of column) {
        const itemHeight = relativeHeight(item.aspectRatio) + spacing.below;
        centers[item.id] = top + offset + itemHeight / 2;
        offset += itemHeight + spacing.gap;
      }
      height = Math.max(height, offset ? offset - spacing.gap : 0);
      columns[index].push(...column);
    });
    top += height + (grouped ? 16 / columnWidth : 0);
    return { key, columns: packed };
  });
  return { sections, columns, centers };
}

/** The name row under each library card's media and the gap after the card,
 *  in the same column-width units as the media's aspect-ratio height. */
export function libraryCardSpacing(containerWidth, cardWidth) {
  const count = columnCount(containerWidth, cardWidth);
  const columnWidth = containerWidth
    ? (containerWidth - 32 - GRID_GAP * (count - 1)) / count
    : cardWidth;
  return { below: GENERATION_NAME_ROW_HEIGHT / columnWidth, gap: GRID_GAP / columnWidth };
}

/** How many cards fit across, honouring the zoom control's card width as a
 *  minimum. Mirrors what `repeat(auto-fill, minmax(cardWidth, 1fr))` would do. */
export function columnCount(containerWidth, cardWidth) {
  // Before the first measurement, guess one column rather than zero: zero
  // columns would drop every item on the floor for a frame.
  if (!containerWidth) return 1;
  const usable = containerWidth - 32; // px-4 either side
  return Math.max(1, Math.floor((usable + GRID_GAP) / (cardWidth + GRID_GAP)));
}

/** Skeleton tiles on the same track definition as the real grid, so the
 *  transition from loading to loaded does not change the column count. */
export function SkeletonGrid({ cardWidth }) {
  return (
    <div
      className="grid gap-3"
      style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${cardWidth}px, 1fr))` }}
    >
      {[180, 240, 200, 280, 160, 220, 260, 190, 210, 250, 175, 230].map((h, i) => (
        <div key={i} className="skeleton rounded-xl" style={{ height: h + GENERATION_NAME_ROW_HEIGHT }} />
      ))}
    </div>
  );
}
