"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import {
  Search,
  ChevronDown,
  Layers,
  LayoutGrid,
  History,
  Check,
  X,
  Star,
  ZoomIn,
  ZoomOut,
  Download,
  Loader2,
} from "lucide-react";
import { useStore } from "@/lib/store";
import { MediaCard } from "./MediaCard";
import { ProjectPanel, EmptyState } from "./ProjectPanel";
import { AssetGrid } from "./AssetGrid";
import { Dropdown, MenuItem } from "./Dropdown";
import { ProjectMenu } from "./ProjectMenu";
import { cn } from "@/lib/utils";
import type { GenerationKind } from "@/lib/types";

const ZOOM_KEY = "veevee-asset-zoom-v1";
const ZOOM_MIN = 120;
const ZOOM_MAX = 260;

export function HistoryPanel() {
  const items = useStore((s) => s.items);
  const loading = useStore((s) => s.loading);
  const refreshing = useStore((s) => s.refreshing);
  const counts = useStore((s) => s.counts);
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
  const activeProjectId = useStore((s) => s.activeProjectId);

  const project = projects.find((p) => p.id === activeProjectId) ?? null;

  const [isDownloadingZip, setIsDownloadingZip] = useState(false);

  // Thumbnail size is a workspace preference, not session state — losing it on
  // every reload made the control feel like it did not work.
  const [assetCardWidth, setAssetCardWidth] = useState(160);
  useEffect(() => {
    try {
      const raw = Number(localStorage.getItem(ZOOM_KEY));
      if (Number.isFinite(raw) && raw >= ZOOM_MIN && raw <= ZOOM_MAX) {
        setAssetCardWidth(raw);
      }
    } catch {
      /* ignore */
    }
  }, []);
  const setZoom = (value: number) => {
    const clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value));
    setAssetCardWidth(clamped);
    try {
      localStorage.setItem(ZOOM_KEY, String(clamped));
    } catch {
      /* ignore */
    }
  };

  // The search box is a local, immediately-responsive value; the store is
  // written on the same keystroke but debounces the query behind it. Binding
  // the input straight to the store would be fine too — this exists so the
  // field never lags behind typing if a render happens to be slow.
  const [searchDraft, setSearchDraft] = useState(search);
  useEffect(() => {
    setSearchDraft(search);
  }, [search]);

  const itemIds = useMemo(() => items.map((i) => i.id), [items]);
  const allSelected =
    itemIds.length > 0 && itemIds.every((id) => selectedIds.includes(id));
  const selectedImageIds = useMemo(
    () =>
      items
        .filter((item) => selectedIds.includes(item.id) && item.kind === "image" && item.url)
        .map((item) => item.id),
    [items, selectedIds]
  );

  const kindLabel =
    filterKind === "all" ? "All types" : filterKind === "image" ? "Images" : "Videos";

  const downloadSelectedZip = async () => {
    if (!selectedImageIds.length || isDownloadingZip) return;
    setIsDownloadingZip(true);
    try {
      const res = await fetch("/api/history/download-zip", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: selectedImageIds }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error || "Failed to build ZIP.");
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `assets-${new Date().toISOString().slice(0, 10)}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (error: any) {
      alert(error?.message || "Failed to download ZIP.");
    } finally {
      setIsDownloadingZip(false);
    }
  };

  return (
    <div className="flex h-full flex-col bg-ink-850">
      {/* ── scope bar ────────────────────────────────────────────────────────
          One row: where you are (project / all / favourites) on the left, how
          you are filtering it on the right.

          NEITHER cluster carries `min-w-0`, and that is the whole trick. Their
          children are `shrink-0`, so a cluster allowed to shrink below its own
          content does not clip — it lets those children spill out and paint
          over whatever sits beside them, which is exactly how the tabs ended up
          rendered on top of the search field. Leaving `min-width: auto` (i.e.
          min-content) means the clusters cannot shrink past their contents, so
          when both no longer fit the parent's `flex-wrap` moves the filters to
          a second row. Overlap stops being a tuning problem and becomes
          structurally impossible; the container queries in globals.css only
          decide how *often* the wrap is needed, never whether things collide. */}
      <div className="scope-bar flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-4 py-2.5">
        <div className="scope-tabs flex items-center gap-1 rounded-full bg-ink-700 p-1">
          {/* Split control: the body is the scope, the chevron is the switcher.
              Previously both were one button, so clicking the project name to
              come back from All assets also flung open the project menu — and
              there was no other route back, since the name looked like a
              dropdown rather than a tab. They are now two sibling buttons
              (nesting them would be invalid HTML), and the name stays legible
              while inactive precisely so it reads as somewhere to return to. */}
          <div
            className={cn(
              "flex items-center rounded-full transition",
              rightTab === "project" && "bg-ink-850 shadow-sm"
            )}
          >
            <button
              onClick={() => setRightTab("project")}
              title={
                project
                  ? rightTab === "project"
                    ? `Project: ${project.name}`
                    : `Back to ${project.name}`
                  : "No project yet"
              }
              className={cn(
                "flex items-center gap-1.5 whitespace-nowrap rounded-l-full py-1.5 pl-3 pr-1.5 text-sm font-medium transition",
                rightTab === "project"
                  ? "text-white"
                  : "text-white/60 hover:text-white/90"
              )}
            >
              <Layers className="h-4 w-4 shrink-0" />
              <span className="scope-project-name max-w-[9rem] truncate">
                {project ? project.name : "Project"}
              </span>
              {counts.project.total > 0 && (
                <ScopeCount n={counts.project.total} active={rightTab === "project"} />
              )}
            </button>

            <Dropdown
              align="left"
              label="Switch project"
              trigger={(open) => (
                <span
                  className={cn(
                    "grid h-7 w-7 place-items-center rounded-full text-white/50 transition hover:bg-white/10 hover:text-white",
                    open && "bg-white/10 text-white"
                  )}
                  title="Switch project"
                >
                  <ChevronDown
                    className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")}
                  />
                </span>
              )}
            >
              {(close) => <ProjectMenu close={close} />}
            </Dropdown>
          </div>

          <TabBtn
            active={rightTab === "history"}
            onClick={() => setRightTab("history")}
            label="All assets"
            count={counts.allAssets}
          >
            <LayoutGrid className="h-4 w-4" />
          </TabBtn>
          <TabBtn
            active={rightTab === "favorites"}
            onClick={() => setRightTab("favorites")}
            label="Favourites"
            count={counts.favorites}
          >
            <Star className="h-4 w-4" />
          </TabBtn>
        </div>

        <div className="scope-actions flex flex-1 items-center justify-end gap-2">
          {/* A real minimum on the field that needs one, rather than on the
              cluster around it. Below this the bar wraps to a second row, which
              is the correct degradation — a clipped search box is not. */}
          <div className="relative min-w-[9rem] flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-white/35" />
            <input
              value={searchDraft}
              onChange={(e) => {
                setSearchDraft(e.target.value);
                setSearch(e.target.value);
              }}
              placeholder="Search prompts"
              aria-label="Search prompts"
              className="w-full rounded-full border border-line bg-ink-700 py-1.5 pl-8 pr-8 text-sm text-white/90 outline-none transition placeholder:text-white/35 focus:border-brand/40 focus:bg-ink-650"
            />
            {/* Search now runs against the database rather than the handful of
                rows the client had loaded, so an active query can hide a lot.
                It needs an obvious way out. */}
            {searchDraft && (
              <button
                onClick={() => {
                  setSearchDraft("");
                  setSearch("");
                }}
                className="absolute right-2 top-1/2 grid h-5 w-5 -translate-y-1/2 place-items-center rounded-full text-white/40 transition hover:bg-white/10 hover:text-white"
                aria-label="Clear search"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
            {refreshing && (
              <Loader2 className="pointer-events-none absolute right-8 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin text-white/30" />
            )}
          </div>

          <Dropdown
            align="right"
            className="shrink-0"
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

          <AssetZoomControl
            value={assetCardWidth}
            onChange={setZoom}
            className="shrink-0"
          />
        </div>
      </div>

      {/* selection toolbar — only while something is selected, so it stops
          costing a permanent row for a count nobody was reading */}
      {selectedIds.length > 0 && (
        <div className="flex min-w-0 flex-wrap items-center gap-2 border-b border-line bg-ink-800/60 px-4 py-2">
          <button
            onClick={() => (allSelected ? clearSelection() : selectAll(itemIds))}
            className="flex items-center gap-2 text-sm text-white/70 transition hover:text-white"
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

          <span className="text-sm text-white/45">{selectedIds.length} selected</span>

          <button
            onClick={downloadSelectedZip}
            disabled={!selectedImageIds.length || isDownloadingZip}
            className="flex items-center gap-2 rounded-full bg-brand/20 px-3 py-1.5 text-sm font-semibold text-brand transition hover:bg-brand/30 disabled:cursor-not-allowed disabled:opacity-40"
            title={
              selectedImageIds.length
                ? "Download selected images as a ZIP"
                : "Select at least one image to download as a ZIP"
            }
          >
            {isDownloadingZip ? (
              "Preparing ZIP…"
            ) : (
              <>
                <Download className="h-3.5 w-3.5" /> Download ZIP
              </>
            )}
          </button>

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
                  className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")}
                />
              </span>
            )}
          >
            {(close) =>
              projects.length === 0 ? (
                <p className="px-2 py-1.5 text-sm text-white/45">No projects yet.</p>
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
            className="ml-auto grid h-7 w-7 place-items-center rounded-lg text-white/55 transition hover:bg-white/10 hover:text-white"
            aria-label="Clear selection"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* body */}
      {rightTab === "project" ? (
        <div className="relative flex min-h-0 flex-1 flex-col">
          <ProjectPanel cardWidth={assetCardWidth} />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <AssetGrid
            items={items}
            loading={loading}
            cardWidth={assetCardWidth}
            empty={
              rightTab === "favorites" ? (
                <EmptyState
                  icon={<Star className="h-6 w-6 text-amber-300/70" />}
                  title={
                    search.trim() || filterKind !== "all"
                      ? "No matching favourites"
                      : "No favourites yet"
                  }
                  body={
                    search.trim() || filterKind !== "all"
                      ? "No starred item matches the current search and type filter."
                      : "Star your best generations and they collect here, newest first."
                  }
                />
              ) : (
                <EmptyState
                  icon={<History className="h-6 w-6" />}
                  title={
                    search.trim() || filterKind !== "all"
                      ? "No matches"
                      : "Nothing generated yet"
                  }
                  body={
                    search.trim() || filterKind !== "all"
                      ? "No generation matches the current search and type filter."
                      : "Every image and video the team generates appears here."
                  }
                />
              )
            }
            renderItem={(item) => <MediaCard item={item} selectable />}
          />
        </div>
      )}
    </div>
  );
}

function ScopeCount({ n, active }: { n: number; active?: boolean }) {
  return (
    <span
      className={cn(
        "scope-tab-count shrink-0 rounded-full px-1.5 text-[11px] font-medium tabular-nums",
        active ? "bg-white/10 text-white/60" : "text-white/35"
      )}
    >
      {n > 999 ? `${Math.floor(n / 1000)}k` : n}
    </span>
  );
}

function TabBtn({
  active,
  onClick,
  label,
  count,
  children,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    // The active pill used to be a shared `layoutId` element that slid between
    // tabs. With the project segment now built differently it could only cover
    // two of the three, so selecting the project made the pill fly sideways and
    // then vanish. A plain background per segment is both correct and one less
    // thing that animates position.
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      className={cn(
        "flex shrink-0 items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm font-medium transition",
        active
          ? "bg-ink-850 text-white shadow-sm"
          : "text-white/55 hover:text-white/90"
      )}
    >
      {children}
      {/* Hidden by the container query when the bar is tight — the icon and
          position still identify the tab, and the space buys back a usable
          search field. */}
      <span className="scope-tab-label whitespace-nowrap">{label}</span>
      {count > 0 && <ScopeCount n={count} active={active} />}
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
        onClick={() => onChange(value - 20)}
        disabled={value <= ZOOM_MIN}
        className="grid h-7 w-7 place-items-center rounded-md text-white/55 transition hover:bg-white/[0.07] hover:text-white disabled:opacity-25"
        aria-label="Zoom assets out"
        title="Smaller assets"
      >
        <ZoomOut className="h-3.5 w-3.5" />
      </button>
      <input
        type="range"
        min={ZOOM_MIN}
        max={ZOOM_MAX}
        step={10}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="scope-zoom-slider h-1.5 w-20 cursor-pointer accent-white"
        aria-label="Asset thumbnail size"
        title={`Asset size: ${value}px`}
      />
      <button
        type="button"
        onClick={() => onChange(value + 20)}
        disabled={value >= ZOOM_MAX}
        className="grid h-7 w-7 place-items-center rounded-md text-white/55 transition hover:bg-white/[0.07] hover:text-white disabled:opacity-25"
        aria-label="Zoom assets in"
        title="Larger assets"
      >
        <ZoomIn className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
