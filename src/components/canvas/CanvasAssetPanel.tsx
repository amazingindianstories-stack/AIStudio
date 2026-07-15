"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import {
  Search,
  LayoutGrid,
  Star,
  Play,
  ChevronsLeft,
  ChevronsRight,
  History,
  Folder,
  FolderOpen,
  Library,
  ChevronDown,
  Check,
} from "lucide-react";
import { aspectToPadding, cn } from "@/lib/utils";
import { useStore } from "@/lib/store";
import { Dropdown, MenuItem } from "@/components/Dropdown";
import type { GenerationItem, Project } from "@/lib/types";

type AssetTab = "assets" | "favourites";
/** "all" or a specific project id (the board's own project, or any other
 *  project the user picked from the list — see AssetScopeControl). */
type AssetScope = string;

const COLLAPSE_KEY = "vivi-canvas-asset-panel-collapsed-v1";
const SCOPE_KEY = "vivi-canvas-asset-scope-v1";

/**
 * Left docked asset library panel (ui-spec §4). Reuses the GLOBAL store's
 * already-loaded `items` — no new fetching/signing logic (D2). Thumbnails
 * are a local, MediaCard-styled re-implementation (not the shared MediaCard
 * component itself, since drag-to-place / click-to-place needs handlers the
 * shared component doesn't expose and it isn't owned by this workstream).
 */
export function CanvasAssetPanel({
  projectId,
  onPlaceAtCenter,
  onCollapsedChange,
}: {
  /** The board's own project — always identical to the global
   *  `activeProjectId` (see design.md's "Open questions"). */
  projectId: string | null;
  onPlaceAtCenter: (asset: { url: string; aspectRatio?: string; kind: GenerationItem["kind"] }) => void;
  onCollapsedChange?: (collapsed: boolean) => void;
}) {
  const items = useStore((s) => s.items);
  const loading = useStore((s) => s.loading);
  const hasMoreHistory = useStore((s) => s.hasMoreHistory);
  const loadMoreHistory = useStore((s) => s.loadMoreHistory);
  const projects = useStore((s) => s.projects);

  const [tab, setTab] = useState<AssetTab>("assets");
  const [scope, setScope] = useState<AssetScope>(() => projectId ?? "all");
  const [search, setSearch] = useState("");
  const [collapsed, setCollapsed] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const observerTarget = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(COLLAPSE_KEY);
      if (raw != null) setCollapsed(raw === "1");
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    onCollapsedChange?.(collapsed);
    try {
      localStorage.setItem(COLLAPSE_KEY, collapsed ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [collapsed, onCollapsedChange]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(SCOPE_KEY);
      // Guard against a stale persisted id from a since-deleted project (or
      // the old binary "project" literal from before this control listed
      // individual projects) — fall back to the board's own project.
      if (raw === "all" || (raw && projects.some((p) => p.id === raw))) {
        setScope(raw);
      } else if (raw != null) {
        setScope(projectId ?? "all");
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    } catch {
      /* ignore */
    }
    // Only re-run once projects have actually loaded, so the validation
    // above has real data to check against.
  }, [projects.length]);

  useEffect(() => {
    try {
      localStorage.setItem(SCOPE_KEY, scope);
    } catch {
      /* ignore */
    }
  }, [scope]);

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
  }, [hasMoreHistory, isLoadingMore, loadMoreHistory, loading, tab]);

  const placeable = useMemo(() => items.filter((i) => i.status === "succeeded"), [items]);

  // Scope -> tab -> search, in that order (design.md "Data flow A"): scope
  // narrows the pool BEFORE the Assets/Favourites tab and search filter it
  // further. Items with no projectId (pre-project-era generations, or items
  // detached from a deleted project) never appear under any specific
  // project — only under "All projects" (spec.md AC2). `scope` is either
  // "all" or a specific project id (the board's own, or any other project
  // picked from the list).
  const scoped = useMemo(() => {
    if (scope === "all") return placeable;
    return placeable.filter((i) => i.projectId === scope);
  }, [placeable, scope]);

  const base = useMemo(
    () => (tab === "favourites" ? scoped.filter((i) => i.isFavorite) : scoped),
    [scoped, tab]
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return base.filter((i) => (q ? i.prompt.toLowerCase().includes(q) : true));
  }, [base, search]);

  // ui-spec §A.5: distinct from "no assets at all" — a single-project scope
  // has nothing, but assets DO exist elsewhere. Switching scope wouldn't
  // help a brand-new user with zero generations anywhere, so that case
  // still falls through to the generic AssetEmptyState below (placeable
  // is empty too).
  const showProjectEmptyNudge = scope !== "all" && scoped.length === 0 && placeable.length > 0;

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={() => setCollapsed(false)}
        aria-label="Show asset panel"
        title="Show asset panel"
        className="absolute left-4 top-4 z-30 grid h-9 w-9 place-items-center rounded-full border border-line bg-ink-750/95 text-white/70 shadow-pop backdrop-blur-xl transition hover:text-white"
      >
        <ChevronsRight className="h-4 w-4" />
      </button>
    );
  }

  return (
    <div className="absolute inset-y-0 left-0 z-20 flex w-[300px] flex-col border-r border-line bg-ink-850">
      <div className="flex items-center gap-1 border-b border-line px-3 py-2.5">
        <div className="flex flex-1 items-center gap-1 rounded-full bg-ink-700 p-1">
          <AssetTabBtn active={tab === "assets"} onClick={() => setTab("assets")}>
            <LayoutGrid className="h-3.5 w-3.5" /> Assets
          </AssetTabBtn>
          <AssetTabBtn active={tab === "favourites"} onClick={() => setTab("favourites")}>
            <Star className="h-3.5 w-3.5" /> Favourites
          </AssetTabBtn>
        </div>
        <button
          type="button"
          onClick={() => setCollapsed(true)}
          aria-label="Collapse asset panel"
          title="Collapse asset panel"
          className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-white/50 hover:bg-white/10 hover:text-white"
        >
          <ChevronsLeft className="h-4 w-4" />
        </button>
      </div>

      <div className="flex items-center border-b border-line px-3 py-2">
        <AssetScopeControl
          scope={scope}
          onChange={setScope}
          currentProjectId={projectId}
          projects={projects}
        />
      </div>

      <div className="border-b border-line px-3 py-2.5">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-white/35" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Prompt keywords"
            className="w-full rounded-full border border-line bg-ink-700 py-1.5 pl-8 pr-3 text-sm text-white/90 placeholder:text-white/35 outline-none transition focus:border-brand/40 focus:bg-ink-650"
          />
        </div>
      </div>

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto p-3">
        {loading ? (
          <AssetSkeletonGrid />
        ) : filtered.length === 0 ? (
          showProjectEmptyNudge ? (
            <ProjectEmptyNudge onShowAllProjects={() => setScope("all")} />
          ) : (
            <AssetEmptyState tab={tab} hasAny={tab === "favourites" ? base.some((i) => i.isFavorite) : base.length > 0} />
          )
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {filtered.map((item) => (
              <AssetThumb key={item.id} item={item} onPlaceAtCenter={onPlaceAtCenter} />
            ))}
          </div>
        )}
        {hasMoreHistory && !loading && (
          <div ref={observerTarget} className="flex h-14 w-full items-center justify-center opacity-50">
            {isLoadingMore ? "Loading more…" : ""}
          </div>
        )}
      </div>
    </div>
  );
}

function AssetTabBtn({
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
        "relative flex flex-1 items-center justify-center gap-1.5 rounded-full px-2 py-1.5 text-xs font-medium transition-colors",
        active ? "text-white" : "text-white/50 hover:text-white/80"
      )}
    >
      {active && (
        <motion.span
          layoutId="canvas-asset-tab"
          transition={{ type: "spring", stiffness: 420, damping: 34 }}
          className="absolute inset-0 rounded-full bg-ink-600 shadow-sm ring-1 ring-line"
        />
      )}
      <span className="relative z-10 flex items-center gap-1.5">{children}</span>
    </button>
  );
}

function AssetThumb({
  item,
  onPlaceAtCenter,
}: {
  item: GenerationItem;
  onPlaceAtCenter: (asset: { url: string; aspectRatio?: string; kind: GenerationItem["kind"] }) => void;
}) {
  const src = item.kind === "video" ? item.poster ?? item.url : item.url;

  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("text/assetId", item.id);
        e.dataTransfer.effectAllowed = "copy";
      }}
      onClick={() => {
        if (src) onPlaceAtCenter({ url: src, aspectRatio: item.aspectRatio, kind: item.kind });
      }}
      title="Drag onto the board · or click to place"
      className="group relative cursor-grab overflow-hidden rounded-lg bg-ink-750 ring-1 ring-line transition hover:shadow-pop hover:ring-lineStrong active:cursor-grabbing"
    >
      <div style={{ paddingBottom: aspectToPadding(item.aspectRatio) }} className="relative w-full">
        {src && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={src}
            alt={item.prompt}
            loading="lazy"
            draggable={false}
            className="absolute inset-0 h-full w-full object-cover"
          />
        )}
        {item.kind === "video" && (
          <div className="pointer-events-none absolute left-1.5 top-1.5 grid h-5 w-5 place-items-center rounded-full bg-black/50 backdrop-blur-sm">
            <Play className="h-2.5 w-2.5 translate-x-px fill-white text-white" />
          </div>
        )}
        {item.isFavorite && (
          <Star className="pointer-events-none absolute right-1.5 top-1.5 h-3.5 w-3.5 fill-amber-300 text-amber-300 drop-shadow" />
        )}
      </div>
    </div>
  );
}

function AssetSkeletonGrid() {
  return (
    <div className="grid grid-cols-2 gap-2">
      {[140, 100, 160, 120, 150, 110].map((h, i) => (
        <div key={i} className="skeleton rounded-lg" style={{ height: h }} />
      ))}
    </div>
  );
}

/**
 * Project-scope control (ui-spec §A.2, per decisions.md D7 which overrides
 * design.md's file-plan one-liner "segmented pill" description): a compact
 * `Dropdown` matching the `BoardSwitcher` trigger idiom scaled to `text-xs`,
 * not a second segmented toggle — the header row is already full at 300px.
 *
 * Extended beyond the original binary This-project/All-projects toggle
 * (canvas-board-v2 D1) to list every individual project, per user request —
 * "This project" stays pinned first for the common case, followed by every
 * other project, then "All projects" last.
 */
function AssetScopeControl({
  scope,
  onChange,
  currentProjectId,
  projects,
}: {
  scope: AssetScope;
  onChange: (scope: AssetScope) => void;
  currentProjectId: string | null;
  projects: Project[];
}) {
  const otherProjects = projects.filter((p) => p.id !== currentProjectId);
  const selectedProject = scope !== "all" ? projects.find((p) => p.id === scope) : undefined;
  const label =
    scope === "all" ? "All projects" : scope === currentProjectId ? "This project" : selectedProject?.name ?? "This project";

  return (
    <Dropdown
      trigger={(open) => (
        <span
          className={cn(
            "inline-flex max-w-full items-center gap-1.5 rounded-full border border-line bg-ink-700 px-2.5 py-1 text-xs text-white/60 transition hover:text-white/90",
            open && "border-brand/40"
          )}
        >
          {scope === "all" ? (
            <Library className="h-3.5 w-3.5 text-white/50" />
          ) : (
            <Folder className="h-3.5 w-3.5 text-white/50" />
          )}
          <span className="truncate">{label}</span>
          <ChevronDown className={cn("h-3 w-3 shrink-0 transition-transform", open && "rotate-180")} />
        </span>
      )}
    >
      {(close) => (
        <div className="w-52">
          {currentProjectId && (
            <MenuItem
              active={scope === currentProjectId}
              onClick={() => {
                onChange(currentProjectId);
                close();
              }}
            >
              <Folder className="h-4 w-4 text-white/50" />
              <span className="flex-1 truncate">This project</span>
              {scope === currentProjectId && <Check className="h-4 w-4 shrink-0 text-brand" />}
            </MenuItem>
          )}
          {otherProjects.length > 0 && (
            <>
              <div className="my-1 h-px bg-line" />
              {otherProjects.map((p) => (
                <MenuItem
                  key={p.id}
                  active={scope === p.id}
                  onClick={() => {
                    onChange(p.id);
                    close();
                  }}
                >
                  <Folder className="h-4 w-4 text-white/50" />
                  <span className="flex-1 truncate">{p.name}</span>
                  {scope === p.id && <Check className="h-4 w-4 shrink-0 text-brand" />}
                </MenuItem>
              ))}
            </>
          )}
          <div className="my-1 h-px bg-line" />
          <MenuItem
            active={scope === "all"}
            onClick={() => {
              onChange("all");
              close();
            }}
          >
            <Library className="h-4 w-4 text-white/50" />
            <span className="flex-1 truncate">All projects</span>
            {scope === "all" && <Check className="h-4 w-4 shrink-0 text-brand" />}
          </MenuItem>
        </div>
      )}
    </Dropdown>
  );
}

/** Distinct empty state (ui-spec §A.5) for "This project scope, zero items
 *  belong to this project, but All projects has items" — the only empty
 *  state with an action button, so it reads differently at a glance from
 *  the passive "Your generations will appear here." */
function ProjectEmptyNudge({ onShowAllProjects }: { onShowAllProjects: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-2 text-center">
      <div className="grid h-14 w-14 place-items-center rounded-2xl bg-ink-700 ring-1 ring-line">
        <FolderOpen className="h-6 w-6 text-white/40" />
      </div>
      <p className="text-sm text-white/55">No assets in this project yet.</p>
      <p className="max-w-xs text-xs text-white/35">
        Your other projects have assets you can use here.
      </p>
      <button
        type="button"
        onClick={onShowAllProjects}
        aria-label="Show all projects"
        className="rounded-lg bg-brand/20 px-3 py-1.5 text-sm font-semibold text-brand hover:bg-brand/30"
      >
        Show all projects
      </button>
    </div>
  );
}

function AssetEmptyState({ tab, hasAny }: { tab: AssetTab; hasAny: boolean }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-2 text-center">
      <div className="grid h-14 w-14 place-items-center rounded-2xl bg-ink-700 ring-1 ring-line">
        {tab === "favourites" ? (
          <Star className="h-6 w-6 text-amber-300/70" />
        ) : (
          <History className="h-6 w-6 text-white/40" />
        )}
      </div>
      <p className="text-sm text-white/55">
        {tab === "favourites"
          ? hasAny
            ? "No favourites match your search."
            : "Star your best generations and they will collect here."
          : hasAny
          ? "No results match your search."
          : "Your generations will appear here."}
      </p>
    </div>
  );
}
