"use client";

import { useMemo, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Search,
  ChevronDown,
  Layers,
  LayoutGrid,
  History,
  Check,
  X,
  Star,
  Image as ImageIcon,
  Play,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useStore } from "@/lib/store";
import { MediaCard } from "./MediaCard";
import { ProjectPanel } from "./ProjectPanel";
import { Dropdown, MenuItem } from "./Dropdown";
import { cn } from "@/lib/utils";
import type { GenerationItem, GenerationKind } from "@/lib/types";

export function HistoryPanel() {
  const items = useStore((s) => s.items);
  const loading = useStore((s) => s.loading);
  const rightTab = useStore((s) => s.rightTab);
  const setRightTab = useStore((s) => s.setRightTab);
  const search = useStore((s) => s.search);
  const setSearch = useStore((s) => s.setSearch);
  const filterKind = useStore((s) => s.filterKind);
  const setFilterKind = useStore((s) => s.setFilterKind);
  const selectedIds = useStore((s) => s.selectedIds);
  const selectAll = useStore((s) => s.selectAll);
  const clearSelection = useStore((s) => s.clearSelection);
  const moveItemsToProject = useStore((s) => s.moveItemsToProject);
  const projects = useStore((s) => s.projects);
  const loadMoreHistory = useStore((s) => s.loadMoreHistory);
  const hasMoreHistory = useStore((s) => s.hasMoreHistory);

  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [assetCardWidth, setAssetCardWidth] = useState(160);
  const observerTarget = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const observer = new IntersectionObserver(
      async (entries) => {
        if (entries[0].isIntersecting && hasMoreHistory && !isLoadingMore && !loading) {
          setIsLoadingMore(true);
          await loadMoreHistory();
          setIsLoadingMore(false);
        }
      },
      { threshold: 0.1 }
    );
    if (observerTarget.current) observer.observe(observerTarget.current);
    return () => observer.disconnect();
    // rightTab: the sentinel remounts when switching tabs, so the observer
    // must re-attach to the new element.
  }, [hasMoreHistory, isLoadingMore, loadMoreHistory, loading, rightTab]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items
      .filter((i) => (filterKind === "all" ? true : i.kind === filterKind))
      .filter((i) => (q ? i.prompt.toLowerCase().includes(q) : true));
  }, [items, search, filterKind]);

  const favorites = useMemo(() => {
    return filtered
      .filter((i) => i.isFavorite)
      .sort(
        (a, b) =>
          (b.favoritedAt ?? b.updatedAt) - (a.favoritedAt ?? a.updatedAt)
      );
  }, [filtered]);
  const favoriteImages = useMemo(
    () => favorites.filter((i) => i.kind === "image"),
    [favorites]
  );
  const favoriteVideos = useMemo(
    () => favorites.filter((i) => i.kind === "video"),
    [favorites]
  );
  const favoriteTotal = items.filter((i) => i.isFavorite).length;

  const filteredIds = useMemo(() => filtered.map((i) => i.id), [filtered]);
  const allSelected =
    filteredIds.length > 0 && filteredIds.every((id) => selectedIds.includes(id));

  const kindLabel =
    filterKind === "all" ? "All types" : filterKind === "image" ? "Images" : "Videos";

  return (
    <div className="flex h-full flex-col bg-ink-850">
      {/* tabs + filters */}
      <div className="grid min-w-0 grid-cols-1 gap-3 border-b border-line px-4 py-3 2xl:grid-cols-[auto_minmax(16rem,1fr)] 2xl:items-center">
        <div className="scroll-none flex w-fit max-w-full items-center gap-1 overflow-x-auto rounded-full bg-ink-700 p-1">
          <TabBtn active={rightTab === "project"} onClick={() => setRightTab("project")}>
            <Layers className="h-4 w-4" /> Project
          </TabBtn>
          <TabBtn active={rightTab === "history"} onClick={() => setRightTab("history")}>
            <LayoutGrid className="h-4 w-4" /> Assets
          </TabBtn>
          <TabBtn
            active={rightTab === "favorites"}
            onClick={() => setRightTab("favorites")}
          >
            <Star className="h-4 w-4" /> Favourites
          </TabBtn>
        </div>

        <div className="flex min-w-0 items-center gap-2 2xl:justify-end">
          <div className="relative min-w-0 flex-1 2xl:max-w-52">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-white/35" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Prompt keywords"
              className="w-full rounded-full border border-line bg-ink-700 py-1.5 pl-8 pr-3 text-sm text-white/90 placeholder:text-white/35 outline-none transition focus:border-brand/40 focus:bg-ink-650"
            />
          </div>

          <Dropdown
            align="right"
            trigger={(open) => (
              <Pill open={open}>
                {kindLabel}
                <ChevronDown
                  className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")}
                />
              </Pill>
            )}
          >
            {(close) =>
              (["all", "image", "video"] as const).map((k) => (
                <MenuItem
                  key={k}
                  active={filterKind === k}
                  onClick={() => {
                    setFilterKind(k as "all" | GenerationKind);
                    close();
                  }}
                >
                  <span className="flex-1 capitalize">
                    {k === "all" ? "All types" : k + "s"}
                  </span>
                  {filterKind === k && <Check className="h-4 w-4 text-brand" />}
                </MenuItem>
              ))
            }
          </Dropdown>
        </div>
      </div>

      {/* body */}
      {rightTab === "project" ? (
        <div className="relative min-h-0 flex-1">
          <ProjectPanel />
        </div>
      ) : rightTab === "favorites" ? (
        <div className="scroll-thin relative min-h-0 flex-1 overflow-y-auto px-4 py-4">
          <div className="mb-3 flex justify-end">
            <AssetZoomControl value={assetCardWidth} onChange={setAssetCardWidth} />
          </div>
          {loading ? (
            <SkeletonGrid />
          ) : favorites.length === 0 ? (
            <EmptyFavorites hasFavorites={favoriteTotal > 0} />
          ) : filterKind === "all" ? (
            <div className="space-y-6">
              {favoriteImages.length > 0 && (
                <FavoriteSection
                  title="Images"
                  count={favoriteImages.length}
                  icon={<ImageIcon className="h-4 w-4" />}
                  items={favoriteImages}
                  cardWidth={assetCardWidth}
                />
              )}
              {favoriteVideos.length > 0 && (
                <FavoriteSection
                  title="Videos"
                  count={favoriteVideos.length}
                  icon={<Play className="h-4 w-4" />}
                  items={favoriteVideos}
                  cardWidth={assetCardWidth}
                />
              )}
            </div>
          ) : (
            <FavoriteSection
              title={filterKind === "image" ? "Images" : "Videos"}
              count={favorites.length}
              icon={
                filterKind === "image" ? (
                  <ImageIcon className="h-4 w-4" />
                ) : (
                  <Play className="h-4 w-4" />
                )
              }
              items={favorites}
              cardWidth={assetCardWidth}
            />
          )}
          {/* favourites are derived from the loaded history pages — keep
              paging until everything favourited is in memory */}
          {hasMoreHistory && !loading && (
            <div
              ref={observerTarget}
              className="flex h-20 w-full items-center justify-center opacity-50"
            >
              {isLoadingMore ? "Loading more..." : ""}
            </div>
          )}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          {/* selection toolbar */}
          {filtered.length > 0 && (
            <div className="flex min-w-0 flex-wrap items-center gap-2 border-b border-line px-4 py-2">
              <button
                onClick={() =>
                  allSelected ? clearSelection() : selectAll(filteredIds)
                }
                className="flex items-center gap-2 text-sm text-white/70 hover:text-white"
              >
                <span
                  className={cn(
                    "grid h-4 w-4 place-items-center rounded border transition",
                    allSelected
                      ? "border-brand bg-brand text-ink-900"
                      : "border-white/40 text-transparent"
                  )}
                >
                  <Check className="h-3 w-3" strokeWidth={3} />
                </span>
                {allSelected ? "Deselect all" : "Select all"}
              </button>

              {selectedIds.length > 0 && (
                <>
                  <span className="text-sm text-white/45">
                    {selectedIds.length} selected
                  </span>
                  <Dropdown
                    align="right"
                    trigger={(open) => (
                      <span
                        className={cn(
                          "flex cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-full bg-brand/20 px-3 py-1.5 text-sm font-semibold text-brand transition hover:bg-brand/30",
                          open && "bg-brand/30"
                        )}
                      >
                        <Layers className="h-3.5 w-3.5" /> Move to project
                        <ChevronDown
                          className={cn(
                            "h-3.5 w-3.5 transition-transform",
                            open && "rotate-180"
                          )}
                        />
                      </span>
                    )}
                  >
                    {(close) =>
                      projects.length === 0 ? (
                        <p className="px-2 py-1.5 text-sm text-white/45">
                          No projects yet.
                        </p>
                      ) : (
                        projects.map((p) => (
                          <MenuItem
                            key={p.id}
                            onClick={() => {
                              moveItemsToProject(selectedIds, p.id, null);
                              close();
                            }}
                          >
                            <Layers className="h-4 w-4 text-white/45" />
                            <span className="flex-1 truncate">{p.name}</span>
                          </MenuItem>
                        ))
                      )
                    }
                  </Dropdown>
                  <button
                    onClick={clearSelection}
                    className="grid h-7 w-7 place-items-center rounded-lg text-white/55 hover:bg-white/10 hover:text-white"
                    aria-label="Clear selection"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </>
              )}

              <AssetZoomControl
                value={assetCardWidth}
                onChange={setAssetCardWidth}
                className="ml-auto"
              />
            </div>
          )}

          <div className="scroll-thin relative flex-1 overflow-y-auto px-4 py-4">
            {loading ? (
              <SkeletonGrid />
            ) : filtered.length === 0 ? (
              <EmptyHistory hasItems={items.length > 0} />
            ) : (
              <div
                className="gap-3 [column-fill:_balance]"
                style={{ columnWidth: `${assetCardWidth}px` }}
              >
                <AnimatePresence mode="popLayout">
                  {filtered.map((item) => (
                    <div key={item.id} className="mb-3 break-inside-avoid">
                      <MediaCard item={item} selectable />
                    </div>
                  ))}
                </AnimatePresence>
                {/* Infinite Scroll Trigger */}
                {hasMoreHistory && (
                  <div
                    ref={observerTarget}
                    className="col-span-full h-20 w-full flex items-center justify-center opacity-50"
                  >
                    {isLoadingMore ? "Loading more..." : ""}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function TabBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "relative flex shrink-0 items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors",
        active ? "text-white" : "text-white/50 hover:text-white/80"
      )}
    >
      {active && (
        <motion.span
          layoutId="right-tab"
          transition={{ type: "spring", stiffness: 420, damping: 34 }}
          className="absolute inset-0 rounded-full bg-ink-600 shadow-sm ring-1 ring-line"
        />
      )}
      <span className="relative z-10 flex items-center gap-1.5">{children}</span>
    </button>
  );
}

function Pill({ open, children }: { open: boolean; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        "flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-line bg-ink-700 px-3 py-1.5 text-sm text-white/75 transition-colors hover:text-white",
        open && "border-brand/40 text-white"
      )}
    >
      {children}
    </span>
  );
}

function SkeletonGrid() {
  const heights = [180, 240, 200, 280, 160, 220, 260, 190];
  return (
    <div className="columns-[10rem] gap-3">
      {heights.map((h, i) => (
        <div
          key={i}
          className="skeleton mb-3 break-inside-avoid rounded-xl"
          style={{ height: h }}
        />
      ))}
    </div>
  );
}

function EmptyHistory({ hasItems }: { hasItems: boolean }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex h-full flex-col items-center justify-center gap-3 text-center"
    >
      <div className="grid h-14 w-14 place-items-center rounded-2xl bg-ink-700 ring-1 ring-line">
        <History className="h-6 w-6 text-white/40" />
      </div>
      <p className="text-sm text-white/55">
        {hasItems ? "No results match your filters." : "Your generations will appear here."}
      </p>
    </motion.div>
  );
}

function FavoriteSection({
  title,
  count,
  icon,
  items,
  cardWidth,
}: {
  title: string;
  count: number;
  icon: React.ReactNode;
  items: GenerationItem[];
  cardWidth: number;
}) {
  return (
    <section>
      <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-white/85">
        <span className="text-amber-300">{icon}</span>
        <span>{title}</span>
        <span className="rounded-full bg-white/[0.08] px-1.5 py-0.5 text-[11px] font-medium text-white/45">
          {count}
        </span>
      </div>
      <div
        className="gap-3 [column-fill:_balance]"
        style={{ columnWidth: `${cardWidth}px` }}
      >
        <AnimatePresence mode="popLayout">
          {items.map((item) => (
            <div key={item.id} className="mb-3 break-inside-avoid">
              <MediaCard item={item} />
            </div>
          ))}
        </AnimatePresence>
      </div>
    </section>
  );
}

function AssetZoomControl({
  value,
  onChange,
  className,
}: {
  value: number;
  onChange: (value: number) => void;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex shrink-0 items-center gap-1 rounded-lg border border-line bg-ink-800 p-1",
        className
      )}
    >
      <button
        type="button"
        onClick={() => onChange(Math.max(120, value - 10))}
        disabled={value <= 120}
        className="grid h-7 w-7 place-items-center rounded-md text-white/55 transition hover:bg-white/[0.07] hover:text-white disabled:opacity-25"
        aria-label="Zoom assets out"
        title="Smaller assets"
      >
        <ZoomOut className="h-3.5 w-3.5" />
      </button>
      <input
        type="range"
        min={120}
        max={260}
        step={10}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="h-1.5 w-20 cursor-pointer accent-white"
        aria-label="Asset thumbnail size"
        title={`Asset size: ${value}px`}
      />
      <button
        type="button"
        onClick={() => onChange(Math.min(260, value + 10))}
        disabled={value >= 260}
        className="grid h-7 w-7 place-items-center rounded-md text-white/55 transition hover:bg-white/[0.07] hover:text-white disabled:opacity-25"
        aria-label="Zoom assets in"
        title="Larger assets"
      >
        <ZoomIn className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function EmptyFavorites({ hasFavorites }: { hasFavorites: boolean }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex h-full flex-col items-center justify-center gap-3 text-center"
    >
      <div className="grid h-14 w-14 place-items-center rounded-2xl bg-ink-700 ring-1 ring-line">
        <Star className="h-6 w-6 text-amber-300/70" />
      </div>
      <p className="text-sm text-white/55">
        {hasFavorites
          ? "No favourites match your filters."
          : "Star your best generations and they will collect here."}
      </p>
    </motion.div>
  );
}
