"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Search,
  ChevronDown,
  Layers,
  LayoutGrid,
  History as HistoryIcon,
  Check,
  X,
  Star,
  ZoomIn,
  ZoomOut,
  Download,
  Loader2,
  Move,
  FileText,
  FolderPlus,
  SlidersHorizontal,
  Trash2,
  AlertCircle,
} from "lucide-react";
import { useStore } from "@/lib/store";
import { apiFetch } from "@/lib/api";
import { MediaCard } from "./MediaCard";
import { EmptyState, BriefEditor } from "./ProjectPanel";
import { AssetGrid } from "./AssetGrid";
import { Dropdown, MenuItem } from "./Dropdown";
import { ProjectMenu } from "./ProjectMenu";
import { FolderTree } from "./FolderTree";
import { BreadcrumbBar } from "./BreadcrumbBar";
import { ChildFolderList } from "./ChildFolderList";
import { DestinationPickerModal } from "./DestinationPickerModal";
import { InlineFolderNameEditor } from "./InlineFolderNameEditor";
import { UNSORTED } from "@/lib/feed-scope";
import { cn } from "@/lib/utils";

const ZOOM_KEY = "veevee-asset-zoom-v1";
const ZOOM_MIN = 120;
const ZOOM_MAX = 260;
const ACTIVE_EXPORT_KEY = "veevee-active-media-export-v1";

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
  const projects = useStore((s) => s.projects);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const activeFolderId = useStore((s) => s.activeFolderId);
  const libraryTree = useStore((s) => s.libraryTree);
  const setActiveProject = useStore((s) => s.setActiveProject);
  const setActiveFolder = useStore((s) => s.setActiveFolder);
  const createFolder = useStore((s) => s.createFolder);
  const moveFolder = useStore((s) => s.moveFolder);
  const moveGenerationsToDestination = useStore((s) => s.moveGenerationsToDestination);
  const deleteGenerations = useStore((s) => s.deleteGenerations);

  const project = projects.find((p) => p.id === activeProjectId) ?? null;

  const [briefView, setBriefView] = useState(false);
  const [addingScope, setAddingScope] = useState(null); // { projectId, parentId } or null
  const [isDownloadingZip, setIsDownloadingZip] = useState(false);
  const [activeExport, setActiveExport] = useState(null);
  const [moveModalOpen, setMoveModalOpen] = useState(false);
  const [movingFolder, setMovingFolder] = useState(null);
  const autoDownloaded = useRef(null);

  // Switching project closes brief view and folder creation
  useEffect(() => {
    setBriefView(false);
    setAddingScope(null);
  }, [activeProjectId]);

  // Active export restoration & polling
  useEffect(() => {
    try {
      const id = localStorage.getItem(ACTIVE_EXPORT_KEY);
      if (id) {
        setActiveExport({
          id,
          status: "queued",
          totalItems: 0,
          processedItems: 0,
          skippedItems: 0,
        });
      }
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    if (!activeExport?.id || !["queued", "running"].includes(activeExport.status)) return;
    let cancelled = false;
    const poll = async () => {
      const response = await apiFetch(`/api/history/exports/${activeExport.id}`);
      if (!response.ok) {
        if (response.status === 404) {
          try {
            localStorage.removeItem(ACTIVE_EXPORT_KEY);
          } catch {}
        }
        return;
      }
      const next = await response.json();
      if (!cancelled) setActiveExport(next);
      if (next.status === "ready" && autoDownloaded.current !== next.id) {
        autoDownloaded.current = next.id;
        window.location.assign(`/api/history/exports/${next.id}/download`);
        try {
          localStorage.removeItem(ACTIVE_EXPORT_KEY);
        } catch {
          /* ignore */
        }
      }
    };
    poll();
    const timer = setInterval(poll, 2000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [activeExport?.id, activeExport?.status]);

  // Thumbnail size zoom control
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

  const setZoom = (value) => {
    const clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value));
    setAssetCardWidth(clamped);
    try {
      localStorage.setItem(ZOOM_KEY, String(clamped));
    } catch {
      /* ignore */
    }
  };

  // Search input draft
  const [searchDraft, setSearchDraft] = useState(search);
  useEffect(() => {
    setSearchDraft(search);
  }, [search]);

  const itemIds = useMemo(() => items.map((i) => i.id), [items]);
  const allSelected = itemIds.length > 0 && itemIds.every((id) => selectedIds.includes(id));
  const selectedExportableIds = useMemo(
    () =>
      items
        .filter(
          (item) =>
            selectedIds.includes(item.id) &&
            ["image", "video", "depth"].includes(item.kind) &&
            item.url
        )
        .map((item) => item.id),
    [items, selectedIds]
  );

  const kindLabel =
    filterKind === "all" ? "All types" : filterKind === "image" ? "Images" : "Videos";

  const downloadSelectedZip = async () => {
    if (!selectedExportableIds.length || isDownloadingZip) return;
    setIsDownloadingZip(true);
    try {
      const res = await apiFetch("/api/history/exports", { method: "POST" });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error || "Failed to create export.");
      }
      const job = await res.json();
      try {
        localStorage.setItem(ACTIVE_EXPORT_KEY, job.id);
      } catch {
        /* ignore */
      }
      let rejected = 0;
      for (let offset = 0; offset < selectedExportableIds.length; offset += 500) {
        const chunkResponse = await apiFetch(`/api/history/exports/${job.id}/items`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids: selectedExportableIds.slice(offset, offset + 500) }),
        });
        const body = await chunkResponse.json().catch(() => ({}));
        if (!chunkResponse.ok) throw new Error(body.error || "Failed to add items to export.");
        rejected += body.rejected?.length || 0;
      }
      const finalize = await apiFetch(`/api/history/exports/${job.id}/finalize`, {
        method: "POST",
      });
      if (!finalize.ok) throw new Error("Failed to queue export.");
      setActiveExport({
        id: job.id,
        status: "queued",
        totalItems: selectedExportableIds.length - rejected,
        processedItems: 0,
        skippedItems: rejected,
      });
    } catch (error) {
      alert(error?.message || "Failed to download ZIP.");
    } finally {
      setIsDownloadingZip(false);
    }
  };

  const retryExport = async () => {
    if (!activeExport?.id) return;
    const response = await apiFetch(`/api/history/exports/${activeExport.id}/finalize`, {
      method: "POST",
    });
    if (response.ok) {
      try {
        localStorage.setItem(ACTIVE_EXPORT_KEY, activeExport.id);
      } catch {}
      setActiveExport((value) => ({ ...value, status: "queued", error: null }));
    }
  };

  const handlePanelKeyDown = (e) => {
    if (moveModalOpen) return;

    if (e.key === "Escape") {
      if (selectedIds.length > 0) {
        e.preventDefault();
        clearSelection();
        return;
      }
    }

    if ((e.metaKey || e.ctrlKey) && (e.key === "f" || e.key === "F")) {
      const searchInput = document.querySelector('input[aria-label="Search prompts"]');
      if (searchInput) {
        e.preventDefault();
        searchInput.focus();
        searchInput.select?.();
      }
    } else if (e.key === "/" && document.activeElement?.tagName !== "INPUT" && document.activeElement?.tagName !== "TEXTAREA") {
      const searchInput = document.querySelector('input[aria-label="Search prompts"]');
      if (searchInput) {
        e.preventDefault();
        searchInput.focus();
        searchInput.select?.();
      }
    }
  };

  // Folder tree nodes for current active workspace
  const activeWorkspaceFolders = useMemo(() => {
    if (activeProjectId) {
      const projData = libraryTree?.projects?.find((p) => p.id === activeProjectId);
      return projData?.folders ?? [];
    }
    return libraryTree?.globalFolders ?? [];
  }, [activeProjectId, libraryTree]);

  const activeCountsByFolder = useMemo(() => {
    if (activeProjectId) {
      return counts.project?.byFolder ?? {};
    }
    return counts.globalLibrary?.byFolder ?? {};
  }, [activeProjectId, counts]);

  return (
    <div
      onKeyDown={handlePanelKeyDown}
      className="flex h-full w-full overflow-hidden bg-ink-850"
    >
      {/* ══════════════════════════════════════════════════════════════════════
          LEFT: PERSISTENT NAVIGATION SIDEBAR (w-60 shrink-0)
          ══════════════════════════════════════════════════════════════════════ */}
      <aside className="flex w-60 shrink-0 flex-col border-r border-line bg-ink-850 select-none">
        {/* Workspace Switcher (~40-44px high) */}
        <Dropdown
          align="left"
          label="Switch workspace"
          className="w-full shrink-0"
          trigger={(open) => (
            <button
              type="button"
              aria-label="Switch project"
              className={cn(
                "flex h-11 w-full items-center justify-between border-b border-line px-3.5 text-left transition hover:bg-white/5 outline-none",
                open && "bg-white/5"
              )}
            >
              <div className="flex min-w-0 items-center gap-2">
                <Layers className="h-4 w-4 shrink-0 text-brand" />
                <span className="scope-project-name truncate text-xs font-semibold uppercase tracking-wider text-white">
                  {activeProjectId === null
                    ? "Global Library"
                    : project
                    ? project.name
                    : "Global Library"}
                </span>
              </div>
              <ChevronDown
                className={cn(
                  "h-3.5 w-3.5 shrink-0 text-white/50 transition-transform",
                  open && "rotate-180"
                )}
              />
            </button>
          )}
        >
          {(close) => <ProjectMenu close={close} />}
        </Dropdown>

        {/* Scrollable Navigation Hierarchy */}
        <div className="scroll-thin flex flex-1 flex-col overflow-y-auto p-2 space-y-4">
          {/* ── SECTION 1: LIBRARY ── */}
          <div className="space-y-0.5">
            <span className="block px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-white/40">
              Library
            </span>
            <SidebarItem
              label="All generations"
              title="All assets"
              count={counts.allAssets}
              icon={<LayoutGrid className="h-3.5 w-3.5" />}
              active={rightTab === "history" && !briefView}
              onClick={() => {
                setRightTab("history");
                setBriefView(false);
              }}
            />
            <SidebarItem
              label="Favourites"
              count={counts.favorites}
              icon={<Star className="h-3.5 w-3.5 text-amber-400" />}
              active={rightTab === "favorites" && !briefView}
              onClick={() => {
                setRightTab("favorites");
                setBriefView(false);
              }}
            />
            <SidebarItem
              label="Global library"
              count={counts.globalLibrary?.total}
              icon={<Layers className="h-3.5 w-3.5 text-white/50" />}
              active={
                rightTab === "project" &&
                activeProjectId === null &&
                activeFolderId === null &&
                !briefView
              }
              onClick={() => {
                setActiveProject(null);
                setActiveFolder(null);
                setRightTab("project");
                setBriefView(false);
              }}
            />
          </div>

          {/* ── SECTION 2: CURRENT PROJECT ── */}
          {project && (
            <div className="space-y-0.5 border-t border-line/60 pt-3">
              <span className="block px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-white/40">
                Current Project
              </span>
              <SidebarItem
                label="Project assets"
                count={counts.project?.total}
                icon={<Layers className="h-3.5 w-3.5 text-brand" />}
                active={
                  rightTab === "project" &&
                  activeProjectId === project.id &&
                  activeFolderId === null &&
                  !briefView
                }
                onClick={() => {
                  setActiveProject(project.id);
                  setActiveFolder(null);
                  setRightTab("project");
                  setBriefView(false);
                }}
              />
              <SidebarItem
                label="Project brief"
                icon={<FileText className="h-3.5 w-3.5 text-white/50" />}
                active={briefView}
                onClick={() => {
                  setActiveProject(project.id);
                  setBriefView(true);
                }}
              />
            </div>
          )}

          {/* ── SECTION 3: FOLDERS ── */}
          <div className="space-y-0.5 border-t border-line/60 pt-3">
            <div className="flex items-center justify-between px-2 pb-1">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-white/40">
                Folders
              </span>
            </div>

            {/* Inline folder editor at root */}
            {addingScope && addingScope.parentId === null && (
              <div className="px-1 py-1">
                <InlineFolderNameEditor
                  label="Folder name"
                  onCommit={async (name) => {
                    await createFolder({ name, ...addingScope });
                    setAddingScope(null);
                  }}
                  onClose={() => setAddingScope(null)}
                />
              </div>
            )}

            {/* Hierarchical folder tree of active workspace */}
            <FolderTree
              folders={activeWorkspaceFolders}
              activeFolderId={rightTab === "project" ? activeFolderId : null}
              countsByFolder={activeCountsByFolder}
              projectId={activeProjectId}
              onSelectFolder={(fId) => {
                setRightTab("project");
                setBriefView(false);
                setActiveFolder(fId);
              }}
              onOpenMoveModal={(folder) => {
                setMovingFolder(folder);
                setMoveModalOpen(true);
              }}
              onOpenNewFolderModal={(scope) => setAddingScope(scope)}
            />

            {/* Inline folder editor for subfolders */}
            {addingScope && addingScope.parentId !== null && (
              <div className="px-1 py-1">
                <InlineFolderNameEditor
                  label="Subfolder name"
                  onCommit={async (name) => {
                    await createFolder({ name, ...addingScope });
                    setAddingScope(null);
                  }}
                  onClose={() => setAddingScope(null)}
                />
              </div>
            )}
          </div>
        </div>
      </aside>

      {/* ══════════════════════════════════════════════════════════════════════
          RIGHT: CURRENT LOCATION + COMMAND BAR + FOLDERS + ASSET CANVAS
          ══════════════════════════════════════════════════════════════════════ */}
      <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-ink-900">
        {/* ── ROW 1: LOCATION / BREADCRUMB ROW (~44px high) ── */}
        <div className="flex h-11 shrink-0 items-center justify-between border-b border-line bg-ink-850 px-4 text-xs select-none">
          {/* Left: Location breadcrumb statement */}
          <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
            {rightTab === "history" ? (
              <div className="flex items-center gap-2 font-semibold text-white">
                <LayoutGrid className="h-4 w-4 text-white/50" />
                <span>All Generations</span>
              </div>
            ) : rightTab === "favorites" ? (
              <div className="flex items-center gap-2 font-semibold text-white">
                <Star className="h-4 w-4 text-amber-400" />
                <span>Favourites</span>
              </div>
            ) : briefView && project ? (
              <div className="flex items-center gap-1.5 font-medium">
                <span className="text-white/60">{project.name}</span>
                <span className="text-white/30">/</span>
                <span className="font-semibold text-white">Project brief</span>
              </div>
            ) : (
              <div className="flex min-w-0 flex-1 items-center">
                <BreadcrumbBar
                  onOpenMoveModal={(folder) => {
                    setMovingFolder(folder);
                    setMoveModalOpen(true);
                  }}
                  onOpenNewFolderModal={null}
                />
              </div>
            )}
          </div>

          {/* Right: Authoritative Primary + New folder button */}
          <div className="flex shrink-0 items-center pl-3">
            <button
              type="button"
              onClick={() => {
                setBriefView(false);
                setRightTab("project");
                setAddingScope({
                  projectId: activeProjectId,
                  parentId: activeFolderId === UNSORTED ? null : activeFolderId,
                });
              }}
              className="flex items-center gap-1.5 rounded-md bg-white/10 px-2.5 py-1 text-xs font-medium text-white transition hover:bg-white/15"
              title="Create new folder"
            >
              <FolderPlus className="h-3.5 w-3.5" />
              <span>+ New folder</span>
            </button>
          </div>
        </div>

        {/* ── ROW 2: ASSET COMMAND BAR WITH IN-PLACE CONTEXTUAL SELECTION (~44px high) ── */}
        {selectedIds.length > 0 ? (
          /* Selection Mode: In-Place Swap (ZERO vertical jump, EXACT same h-11) */
          <div
            data-testid="selection-toolbar"
            className="flex h-11 shrink-0 items-center justify-between border-b border-line bg-ink-800/90 px-4 text-xs select-none"
          >
            {/* Left: Select all & count */}
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => (allSelected ? clearSelection() : selectAll(itemIds))}
                className="flex items-center gap-1.5 font-medium text-white/75 transition hover:text-white"
              >
                <span
                  className={cn(
                    "grid h-3.5 w-3.5 place-items-center rounded border transition",
                    allSelected
                      ? "border-brand bg-brand text-ink-900"
                      : "border-white/40 text-transparent"
                  )}
                >
                  <Check className="h-2.5 w-2.5" strokeWidth={3} />
                </span>
                <span>{allSelected ? "Deselect all" : "Select all"}</span>
              </button>

              <span className="text-white/30">|</span>

              <span className="font-semibold text-white">
                ✓ {selectedIds.length} selected
              </span>
            </div>

            {/* Right: Contextual actions */}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={downloadSelectedZip}
                disabled={!selectedExportableIds.length || isDownloadingZip}
                className="flex items-center gap-1.5 rounded-full bg-brand/20 px-3 py-1 font-semibold text-brand transition hover:bg-brand/30 disabled:cursor-not-allowed disabled:opacity-40"
                title="Download selected items as ZIP"
              >
                {isDownloadingZip ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Download className="h-3.5 w-3.5" />
                )}
                <span>Download ZIP</span>
              </button>

              <button
                type="button"
                onClick={() => setMoveModalOpen(true)}
                className="flex items-center gap-1.5 rounded-full bg-brand/20 px-3 py-1 font-semibold text-brand transition hover:bg-brand/30"
                title="Move selected items"
              >
                <Move className="h-3.5 w-3.5" />
                <span>Move</span>
              </button>

              {/* More Actions Dropdown */}
              <Dropdown
                align="right"
                label="More actions"
                trigger={(open) => (
                  <button
                    type="button"
                    className={cn(
                      "flex items-center gap-1 rounded-full border border-line bg-ink-700/80 px-2.5 py-1 text-white/75 transition hover:text-white",
                      open && "border-brand/40 text-white"
                    )}
                  >
                    <span>More</span>
                    <ChevronDown
                      className={cn("h-3 w-3 transition-transform", open && "rotate-180")}
                    />
                  </button>
                )}
              >
                {(close) => (
                  <div className="py-1 min-w-[150px]">
                    {project && (
                      <MenuItem
                        onClick={() => {
                          close();
                          moveGenerationsToDestination(selectedIds, { type: "global_root" });
                        }}
                      >
                        <span>Remove from Project</span>
                      </MenuItem>
                    )}
                    <MenuItem
                      onClick={() => {
                        close();
                        if (
                          window.confirm(
                            `Delete ${selectedIds.length} items? This cannot be undone.`
                          )
                        ) {
                          deleteGenerations(selectedIds);
                        }
                      }}
                      className="text-red-400 hover:text-red-300"
                    >
                      <Trash2 className="h-3.5 w-3.5 text-red-400" />
                      <span>Delete</span>
                    </MenuItem>
                  </div>
                )}
              </Dropdown>

              {/* Clear Selection */}
              <button
                type="button"
                onClick={clearSelection}
                className="grid h-7 w-7 place-items-center rounded-md text-white/50 transition hover:bg-white/10 hover:text-white"
                title="Clear selection (Esc)"
                aria-label="Clear selection"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        ) : (
          /* Normal State: Search + Filters + View (EXACT same h-11) */
          <div className="flex h-11 shrink-0 items-center justify-between gap-3 border-b border-line bg-ink-850 px-4 select-none">
            {/* Search Input (max-w ~380px) */}
            <div className="relative w-full max-w-sm sm:max-w-md">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-white/35" />
              <input
                value={searchDraft}
                onChange={(e) => {
                  setSearchDraft(e.target.value);
                  setSearch(e.target.value);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    if (searchDraft) {
                      e.preventDefault();
                      setSearchDraft("");
                      setSearch("");
                    }
                  }
                }}
                placeholder="Search assets…"
                aria-label="Search prompts"
                className="w-full rounded-full border border-line bg-ink-700/80 py-1 pl-8 pr-8 text-xs text-white/90 outline-none transition placeholder:text-white/35 focus:border-brand/40 focus:bg-ink-650"
              />
              {searchDraft && (
                <button
                  type="button"
                  onClick={() => {
                    setSearchDraft("");
                    setSearch("");
                  }}
                  className="absolute right-2 top-1/2 grid h-4 w-4 -translate-y-1/2 place-items-center rounded-full text-white/40 transition hover:bg-white/10 hover:text-white"
                  aria-label="Clear search"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
              {refreshing && (
                <Loader2 className="pointer-events-none absolute right-7 top-1/2 h-3 w-3 -translate-y-1/2 animate-spin text-white/30" />
              )}
            </div>

            {/* Type Filter & View Controls */}
            <div className="flex items-center gap-2 shrink-0">
              {/* Type Filter Dropdown */}
              <Dropdown
                align="right"
                label="Filter by type"
                trigger={(open) => (
                  <button
                    type="button"
                    className={cn(
                      "flex items-center gap-1.5 rounded-full border border-line bg-ink-700/80 px-3 py-1 text-xs text-white/75 transition hover:text-white",
                      open && "border-brand/40 text-white"
                    )}
                  >
                    <span>{kindLabel}</span>
                    <ChevronDown
                      className={cn("h-3 w-3 transition-transform", open && "rotate-180")}
                    />
                  </button>
                )}
              >
                {(close) =>
                  ["all", "image", "video"].map((k) => (
                    <MenuItem
                      key={k}
                      active={filterKind === k}
                      onClick={() => {
                        setFilterKind(k);
                        close();
                      }}
                    >
                      <span className="flex-1 capitalize">
                        {k === "all" ? "All types" : k + "s"}
                      </span>
                      {filterKind === k && <Check className="h-3.5 w-3.5 text-brand" />}
                    </MenuItem>
                  ))
                }
              </Dropdown>

              {/* View Dropdown (Thumbnail Size Slider) */}
              <Dropdown
                align="right"
                label="View settings"
                trigger={(open) => (
                  <button
                    type="button"
                    className={cn(
                      "flex items-center gap-1.5 rounded-full border border-line bg-ink-700/80 px-3 py-1 text-xs text-white/75 transition hover:text-white",
                      open && "border-brand/40 text-white"
                    )}
                  >
                    <SlidersHorizontal className="h-3 w-3" />
                    <span>View</span>
                    <ChevronDown
                      className={cn("h-3 w-3 transition-transform", open && "rotate-180")}
                    />
                  </button>
                )}
              >
                {() => (
                  <div className="p-2.5 space-y-2 w-48">
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-white/40 block">
                      Thumbnail Size
                    </span>
                    <div className="flex items-center justify-between gap-2">
                      <button
                        type="button"
                        onClick={() => setZoom(assetCardWidth - 20)}
                        disabled={assetCardWidth <= ZOOM_MIN}
                        className="grid h-6 w-6 place-items-center rounded text-white/50 hover:bg-white/10 hover:text-white disabled:opacity-20"
                        title="Smaller"
                      >
                        <ZoomOut className="h-3 w-3" />
                      </button>
                      <input
                        type="range"
                        min={ZOOM_MIN}
                        max={ZOOM_MAX}
                        step={10}
                        value={assetCardWidth}
                        onChange={(e) => setZoom(Number(e.target.value))}
                        className="h-1.5 flex-1 cursor-pointer accent-brand"
                      />
                      <button
                        type="button"
                        onClick={() => setZoom(assetCardWidth + 20)}
                        disabled={assetCardWidth >= ZOOM_MAX}
                        className="grid h-6 w-6 place-items-center rounded text-white/50 hover:bg-white/10 hover:text-white disabled:opacity-20"
                        title="Larger"
                      >
                        <ZoomIn className="h-3 w-3" />
                      </button>
                    </div>
                  </div>
                )}
              </Dropdown>
            </div>
          </div>
        )}

        {/* ── ROW 3: OPTIONAL COMPACT FOLDER SECTION (COLLAPSED BY DEFAULT) ── */}
        {!briefView && rightTab === "project" && activeFolderId !== UNSORTED && (
          <ChildFolderList
            parentId={activeFolderId}
            projectId={activeProjectId}
            onOpenMoveModal={(folder) => {
              setMovingFolder(folder);
              setMoveModalOpen(true);
            }}
            onOpenNewFolderModal={() =>
              setAddingScope({
                projectId: activeProjectId,
                parentId: activeFolderId,
              })
            }
          />
        )}

        {/* ── ROW 4: MAIN CANVAS (BRIEF OR ASSET GRID DOMINATING SCREEN) ── */}
        <div className="flex min-h-0 flex-1 flex-col">
          {briefView && project ? (
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              <BriefEditor projectId={project.id} brief={project.brief ?? ""} />
            </div>
          ) : (
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
                    icon={<HistoryIcon className="h-6 w-6" />}
                    title={
                      search.trim() || filterKind !== "all"
                        ? "No matches"
                        : "Nothing generated yet"
                    }
                    body={
                      search.trim() || filterKind !== "all"
                        ? "No generation matches the current search and type filter."
                        : "Every image and video generated appears here."
                    }
                  />
                )
              }
              renderItem={(item) => <MediaCard key={item.id} item={item} selectable />}
            />
          )}
        </div>
      </main>

      {/* ══════════════════════════════════════════════════════════════════════
          FLOATING ANCHORED ZIP PROGRESS TOAST (BOTTOM-RIGHT, NEVER PUSHES GRID)
          ══════════════════════════════════════════════════════════════════════ */}
      {activeExport && (
        <div
          role="status"
          aria-live="polite"
          className="fixed bottom-5 right-5 z-50 flex items-center gap-3 rounded-xl border border-line bg-ink-750/95 px-4 py-2.5 shadow-2xl backdrop-blur-xl text-xs text-white select-none animate-in fade-in slide-in-from-bottom-2 duration-200"
        >
          {["queued", "running"].includes(activeExport.status) && (
            <>
              <Loader2 className="h-4 w-4 animate-spin text-brand" />
              <span>
                {activeExport.status === "queued"
                  ? "ZIP queued…"
                  : `Building ZIP ${activeExport.processedItems} / ${activeExport.totalItems}`}
                {activeExport.skippedItems ? ` · ${activeExport.skippedItems} skipped` : ""}
              </span>
            </>
          )}
          {activeExport.status === "ready" && (
            <>
              <Check className="h-4 w-4 text-emerald-400" />
              <span>
                ZIP ready{activeExport.skippedItems ? ` · ${activeExport.skippedItems} skipped` : ""}
              </span>
              <a
                href={`/api/history/exports/${activeExport.id}/download`}
                className="font-semibold text-brand hover:underline"
              >
                Download
              </a>
            </>
          )}
          {activeExport.status === "failed" && (
            <>
              <AlertCircle className="h-4 w-4 text-rose-400" />
              <span className="text-rose-300">{activeExport.error || "ZIP export failed."}</span>
              <button
                type="button"
                onClick={retryExport}
                className="font-semibold text-brand hover:underline"
              >
                Retry
              </button>
            </>
          )}
          <button
            type="button"
            onClick={() => {
              try {
                localStorage.removeItem(ACTIVE_EXPORT_KEY);
              } catch {}
              setActiveExport(null);
            }}
            className="ml-1 text-white/40 hover:text-white"
            aria-label="Dismiss export notice"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Destination Picker Modal for Moving Assets or Folders */}
      <DestinationPickerModal
        open={moveModalOpen}
        onClose={() => {
          setMoveModalOpen(false);
          setMovingFolder(null);
        }}
        title={
          movingFolder
            ? `Move "${movingFolder.name}"`
            : `Move ${selectedIds.length} ${selectedIds.length === 1 ? "item" : "items"}`
        }
        onConfirm={async (destination) => {
          if (movingFolder) {
            await moveFolder(movingFolder.id, destination);
          } else {
            await moveGenerationsToDestination(selectedIds, destination);
          }
        }}
      />
    </div>
  );
}

function SidebarItem({ label, title, count, icon, active, onClick }) {
  const displayTitle = title || label;
  return (
    <button
      type="button"
      title={displayTitle}
      aria-label={displayTitle}
      onClick={onClick}
      className={cn(
        "flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-xs font-medium transition text-left select-none outline-none focus-visible:ring-1 focus-visible:ring-brand",
        active ? "bg-brand/15 text-white" : "text-white/70 hover:bg-white/5 hover:text-white"
      )}
    >
      <div className="flex items-center gap-2 min-w-0">
        <span className={cn("shrink-0", active ? "text-brand" : "text-white/50")}>{icon}</span>
        <span className="truncate">{label}</span>
      </div>
      {count !== undefined && count > 0 && (
        <span
          className={cn(
            "text-[10px] tabular-nums shrink-0",
            active ? "text-brand/90" : "text-white/40"
          )}
        >
          {count > 999 ? `${Math.floor(count / 1000)}k` : count}
        </span>
      )}
    </button>
  );
}
