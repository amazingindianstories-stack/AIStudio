"use client";

import { useMaintenance } from "@/lib/maintenance-client";

import { notify } from "@/lib/notify";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { EXPORT_POLL_MAX_MS, exportPollDelay } from "@/lib/poll-schedule";
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
  Inbox,
  MoreHorizontal,
} from "lucide-react";
import { useStore } from "@/lib/store";
import { apiFetch } from "@/lib/api";
import { MediaCard } from "./MediaCard";
import { EmptyState, BriefEditor } from "./ProjectPanel";
import { AssetGrid } from "./AssetGrid";
import { LibraryFilters, LibraryFilterChips, LibraryNoMatches, LibraryResultsAnnouncer } from "./LibraryFilters";
import { activeLibraryFilters } from "@/lib/library-filters";
import { useLibraryDayClock } from "@/lib/use-library-day-clock";
import { Dropdown, MenuItem } from "./Dropdown";
import { ProjectMenu } from "./ProjectMenu";
import { getAssetDragData, isFolderDragEvent } from "@/lib/asset-drag-contract";
import { FolderTree, FolderOperationRail } from "./FolderTree";
import { BreadcrumbBar } from "./BreadcrumbBar";
import { ChildFolderList } from "./ChildFolderList";
import { DestinationPickerModal } from "./DestinationPickerModal";
import { InlineFolderNameEditor } from "./InlineFolderNameEditor";
import { UNSORTED } from "@/lib/feed-scope";
import { cn } from "@/lib/utils";
import { apiErrorMessage } from "@/lib/api-error";
import { askConfirm } from "@/lib/ask-text";

const ZOOM_KEY = "veevee-asset-zoom-v1";
const ZOOM_MIN = 120;
const ZOOM_MAX = 260;
const ACTIVE_EXPORT_KEY = "veevee-active-media-export-v1";

export function HistoryPanel({ drawer = false }) {
  const maintenance = useMaintenance((s) => s.enabled);
  const isAdmin = useStore((s) => s.currentUser?.role === "admin");
  const actorId = useStore((s) => s.currentUser?.id);
  const items = useStore((s) => s.items);
  const loading = useStore((s) => s.loading);
  const refreshing = useStore((s) => s.refreshing);
  const counts = useStore((s) => s.counts);
  const rightTab = useStore((s) => s.rightTab);
  const setRightTab = useStore((s) => s.setRightTab);
  const search = useStore((s) => s.search);
  const setSearch = useStore((s) => s.setSearch);
  const filterKind = useStore((s) => s.filterKind);
  const libraryFilters = useStore((s) => s.libraryFilters);
  const librarySort = useStore((s) => s.librarySort);
  const setLibrarySort = useStore((s) => s.setLibrarySort);
  const groupByDate = useStore((s) => s.libraryGroupByDate);
  const setGroupByDate = useStore((s) => s.setLibraryGroupByDate);
  const feedError = useStore((s) => s.feedError);
  const loadFeed = useStore((s) => s.loadFeed);
  useLibraryDayClock();
  const filtering = Boolean(search.trim()) || filterKind !== "all" || activeLibraryFilters(libraryFilters).length > 0;
  const sort = librarySort || (rightTab === "favorites" ? "starred" : "newest");
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

  const [navigationOpen, setNavigationOpen] = useState(false);
  const navigationToggle = useRef(null);
  const navigationId = useId();
  const [unsortedDrop, setUnsortedDrop] = useState(false);
  const [folderDropError, setFolderDropError] = useState("");
  const [briefView, setBriefView] = useState(false);
  const [addingScope, setAddingScope] = useState(null); // { projectId, parentId } or null
  const [isDownloadingZip, setIsDownloadingZip] = useState(false);
  const [activeExport, setActiveExport] = useState(null);
  const [moveModalOpen, setMoveModalOpen] = useState(false);
  const [movingFolder, setMovingFolder] = useState(null);
  const exportBusy = useRef(false);
  const downloadFrame = useRef(null);
  const exportStorageKey = actorId ? `${ACTIVE_EXPORT_KEY}:${actorId}` : null;
  const displayedExport = activeExport?.actorId === actorId ? activeExport : null;

  // Switching project closes brief view and folder creation
  useEffect(() => {
    setBriefView(false);
    setAddingScope(null);
  }, [activeProjectId]);

  // Only identifiers are persisted, isolated by actor; grants require a click.
  useEffect(() => {
    setActiveExport(null);
    if (!exportStorageKey) return;
    try {
      localStorage.removeItem(ACTIVE_EXPORT_KEY); // Discard legacy unscoped state.
      const id = localStorage.getItem(exportStorageKey);
      if (id) setActiveExport({ id, actorId, status: "queued", totalItems: 0, processedItems: 0 });
    } catch {}
  }, [actorId, exportStorageKey]);

  useEffect(() => {
    if (!displayedExport?.id || !["queued", "running"].includes(displayedExport.status)) return;
    let cancelled = false;
    let timer = null;
    let attempt = 0;
    let failures = 0;
    const startedAt = Date.now();
    // Self-scheduling: pauses while the tab is hidden, slows for long jobs and
    // backs off on errors instead of a fixed 2 s interval forever.
    const schedule = () => {
      if (cancelled) return;
      if (Date.now() - startedAt > EXPORT_POLL_MAX_MS) {
        setActiveExport((value) => (value ? { ...value, pollError: "Still preparing. Reopen the panel to check again." } : value));
        return;
      }
      timer = setTimeout(tick, exportPollDelay(attempt, failures));
    };
    const tick = async (force = false) => {
      if (cancelled) return;
      // The first check always runs; later checks pause while hidden and resume on visibilitychange.
      if (!force && typeof document !== "undefined" && document.hidden) return;
      attempt += 1;
      const ok = await poll();
      failures = ok ? 0 : failures + 1;
      schedule();
    };
    const onVisible = () => {
      if (!cancelled && !document.hidden) { clearTimeout(timer); tick(); }
    };
    const poll = async () => {
      try {
        const response = await apiFetch(`/api/history/exports/${displayedExport.id}`, { cache: "no-store" });
        if (cancelled) return;
        if (!response.ok) {
          if ([401, 403, 404].includes(response.status)) {
            try { localStorage.removeItem(exportStorageKey); } catch {}
            setActiveExport(null);
          } else if (response.status === 410) {
            setActiveExport((value) => ({ ...value, status: "expired", error: "ZIP expired. Select the items and create a new ZIP." }));
          } else {
            setActiveExport((value) => ({ ...value, pollError: "Cannot check ZIP status. Retrying…" }));
            return false;
          }
          return true;
        }
        const next = await response.json();
        if (next.status === "draft") {
          next.status = "failed";
          next.canRetry = false;
          next.error = "ZIP selection was interrupted. Select the items and create a new ZIP.";
        } else if (next.status === "ready" && next.expiresAt && next.expiresAt <= Date.now()) {
          next.status = "expired";
          next.error = "ZIP expired. Select the items and create a new ZIP.";
        }
        if (!cancelled) setActiveExport({ ...next, actorId });
        return true;
      } catch {
        if (!cancelled) setActiveExport((value) => ({ ...value, pollError: "Cannot check ZIP status. Retrying…" }));
        return false;
      }
    };
    tick(true);
    document.addEventListener("visibilitychange", onVisible);
    return () => { cancelled = true; clearTimeout(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [displayedExport?.id, displayedExport?.status, actorId, exportStorageKey]);

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

  const downloadSelectedZip = async () => {
    if (!selectedExportableIds.length || exportBusy.current || !actorId) return;
    exportBusy.current = true;
    const ids = [...selectedExportableIds];
    const stillActor = () => useStore.getState().currentUser?.id === actorId;
    setIsDownloadingZip(true);
    try {
      const res = await apiFetch("/api/history/exports", { method: "POST" });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(apiErrorMessage(json, res.status, "Failed to create export."));
      }
      const job = await res.json();
      try {
        localStorage.setItem(exportStorageKey, job.id);
      } catch {
        /* ignore */
      }
      if (!stillActor()) return;
      setActiveExport({ id: job.id, actorId, status: "draft", totalItems: ids.length });
      let rejected = 0;
      for (let offset = 0; offset < ids.length; offset += 500) {
        const chunkResponse = await apiFetch(`/api/history/exports/${job.id}/items`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids: ids.slice(offset, offset + 500) }),
        });
        const body = await chunkResponse.json().catch(() => ({}));
        if (!chunkResponse.ok) throw new Error(apiErrorMessage(body, chunkResponse.status, "Failed to add items to export."));
        rejected += body.rejected?.length || 0;
      }
      if (rejected) {
        const error = new Error(`${rejected} selected items are unavailable. Review the selection and create a new ZIP.`);
        error.canRetry = false;
        throw error;
      }
      if (!stillActor()) return;
      const finalize = await apiFetch(`/api/history/exports/${job.id}/finalize`, {
        method: "POST",
      });
      const finalized = await finalize.json().catch(() => ({}));
      if (!finalize.ok) throw new Error(apiErrorMessage(finalized, finalize.status, "Failed to queue export."));
      if (!stillActor()) return;
      setActiveExport({
        id: job.id,
        actorId,
        status: "queued",
        totalItems: ids.length - rejected,
        processedItems: 0,
        skippedItems: rejected,
      });
    } catch (error) {
      if (stillActor()) setActiveExport((value) => ({ ...value, actorId, status: "failed", error: error?.message || "Failed to create ZIP.", canRetry: Boolean(value?.id) && error.canRetry !== false }));
    } finally {
      exportBusy.current = false;
      setIsDownloadingZip(false);
    }
  };

  const retryExport = async () => {
    if (!displayedExport?.id || exportBusy.current) return;
    exportBusy.current = true;
    setIsDownloadingZip(true);
    try {
      const response = await apiFetch(`/api/history/exports/${displayedExport.id}/finalize`, { method: "POST" });
      const result = await response.json().catch(() => ({}));
      if (useStore.getState().currentUser?.id !== actorId) return;
      if (!response.ok) throw new Error(apiErrorMessage(result, response.status, "Could not retry ZIP. Try again."));
      try { localStorage.setItem(exportStorageKey, displayedExport.id); } catch {}
      setActiveExport((value) => ({ ...value, status: "queued", error: null }));
    } catch (error) {
      if (useStore.getState().currentUser?.id === actorId) setActiveExport((value) => ({ ...value, error: error.message }));
    } finally { exportBusy.current = false; setIsDownloadingZip(false); }
  };

  const downloadExport = async (event) => {
    event.preventDefault();
    if (!displayedExport?.id || exportBusy.current) return;
    exportBusy.current = true;
    try {
      const response = await apiFetch(`/api/history/exports/${displayedExport.id}`, { cache: "no-store" });
      const result = await response.json().catch(() => ({}));
      if (useStore.getState().currentUser?.id !== actorId) return;
      if (!response.ok) throw new Error("ZIP is unavailable. Refresh the selection and try again.");
      if (result.expiresAt && result.expiresAt <= Date.now()) {
        setActiveExport((value) => ({ ...value, status: "expired", error: "ZIP expired. Select the items and create a new ZIP." }));
        return;
      }
      if (result.status !== "ready") throw new Error(result.error || "ZIP is not ready. Check its status and try again.");
      downloadFrame.current.src = `/api/history/exports/${displayedExport.id}/download`;
    } catch (error) {
      if (useStore.getState().currentUser?.id === actorId) setActiveExport((value) => ({ ...value, downloadError: error.message }));
    } finally { exportBusy.current = false; }
  };

  const showAssets = () => {
    if (!navigationOpen) return;
    setNavigationOpen(false);
    navigationToggle.current?.focus();
  };

  const handlePanelKeyDown = (e) => {
    if (moveModalOpen) return;

    if (e.key === "Escape") {
      if (navigationOpen) {
        e.preventDefault();
        e.stopPropagation();
        // The app root is the document, so the phone drawer's own document
        // Escape listener shares this node; only an immediate stop reaches it.
        e.nativeEvent.stopImmediatePropagation();
        showAssets();
        return;
      }
      if (selectedIds.length > 0) {
        e.preventDefault();
        clearSelection();
        return;
      }
    }

    // Portaled menus bubble here through React; leaving Folders view from one
    // would hide its trigger and orphan the open menu over the asset grid.
    const fromOpenMenu =
      !e.currentTarget.contains(e.target) || e.target.closest('[aria-haspopup="menu"][aria-expanded="true"]');
    if (
      !fromOpenMenu &&
      (((e.metaKey || e.ctrlKey) && (e.key === "f" || e.key === "F")) ||
        (e.key === "/" && document.activeElement?.tagName !== "INPUT" && document.activeElement?.tagName !== "TEXTAREA"))
    ) {
      const searchInput = document.querySelector('input[aria-label="Search prompts"]');
      if (searchInput) {
        e.preventDefault();
        if (navigationOpen) flushSync(() => setNavigationOpen(false));
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
      data-drawer={drawer}
      data-navigation-open={navigationOpen}
      className="history-panel h-full w-full overflow-hidden bg-ink-850"
    >
      <div className="history-layout flex h-full w-full">
        {/* ══════════════════════════════════════════════════════════════════════
            LEFT: NAVIGATION SIDEBAR (the drawer swaps it with the assets via Folders)
            ══════════════════════════════════════════════════════════════════════ */}
        {drawer && (
          <div className="flex shrink-0 items-center border-b border-line px-3 py-2">
            <button ref={navigationToggle} type="button" aria-expanded={navigationOpen} aria-controls={navigationId}
              onClick={() => setNavigationOpen((open) => !open)}
              className="flex items-center gap-2 rounded-md px-2 py-1 text-xs font-medium text-white/80 hover:bg-white/10">
              <Layers className="h-4 w-4" />{navigationOpen ? "Back to assets" : "Folders"}
            </button>
          </div>
        )}
        <aside id={navigationId} aria-label="Library folders" className="history-navigation flex min-h-0 shrink-0 flex-col border-r border-line bg-ink-850 select-none">
          {/* Workspace Switcher (~40-44px high) */}
          <Dropdown
            align="left"
            label="Switch workspace"
            className="w-full shrink-0"
            triggerClassName="w-full"
            trigger={(open) => (
              <span
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
              </span>
            )}
          >
            {(close) => <ProjectMenu close={close} />}
          </Dropdown>

          {/* Scrollable Navigation Hierarchy */}
          <div className="scroll-thin flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto overflow-x-hidden p-2 space-y-4">
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
                  showAssets();
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
                  showAssets();
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
                  showAssets();
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
                    showAssets();
                  }}
                />
                <SidebarItem
                  label="Project brief"
                  icon={<FileText className="h-3.5 w-3.5 text-white/50" />}
                  active={briefView}
                  onClick={() => {
                    setActiveProject(project.id);
                    setBriefView(true);
                    showAssets();
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
                  showAssets();
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
          <div data-testid="sticky-unsorted-rail" className="shrink-0 border-t border-line bg-ink-850 p-2">
            <button type="button" aria-label={`${project?.name || "Global"} Unsorted`} onClick={() => { setRightTab("project"); setBriefView(false); setActiveFolder(UNSORTED); showAssets(); }}
              onDragOver={(e) => { e.preventDefault(); const valid = isAdmin && !maintenance && !isFolderDragEvent(e); e.dataTransfer.dropEffect = valid ? "move" : "none"; setUnsortedDrop(valid); }}
              onDragLeave={() => setUnsortedDrop(false)}
              onDrop={(e) => { e.preventDefault(); setUnsortedDrop(false); if (maintenance || !isAdmin || isFolderDragEvent(e)) return; const { ids } = getAssetDragData(e, useStore.getState()); if (!ids.length) return; setFolderDropError(""); void moveGenerationsToDestination(ids, activeProjectId ? { type: "project_unsorted", projectId: activeProjectId } : { type: "global_unsorted" }).catch((err) => setFolderDropError(err.message)); }}
              className={cn("flex w-full items-center gap-2 rounded px-2 py-2 text-xs text-white/70", activeFolderId === UNSORTED && rightTab === "project" && "bg-brand/15 text-white", unsortedDrop && "ring-1 ring-brand bg-brand/20")}>
              <Inbox className="h-4 w-4" /><span className="flex-1 text-left">Unsorted</span><span>{activeProjectId ? counts.project?.unsorted ?? 0 : counts.globalLibrary?.unsorted ?? 0}</span>
            </button>
            {folderDropError && <p role="alert" className="text-xs text-red-400">{folderDropError}</p>}
          </div>
          <FolderOperationRail />
        </aside>

        {/* ══════════════════════════════════════════════════════════════════════
            RIGHT: CURRENT LOCATION + COMMAND BAR + FOLDERS + ASSET CANVAS
            ══════════════════════════════════════════════════════════════════════ */}
        <main className="history-main flex min-h-0 min-w-0 flex-1 flex-col bg-ink-900">
          {/* ── ROW 1: LOCATION / BREADCRUMB ROW (~44px high) ── */}
          <div className="flex h-11 shrink-0 items-center justify-between border-b border-line bg-ink-850 px-4 text-xs select-none">
            {/* Left: Location breadcrumb statement */}
            <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
              {rightTab === "history" ? (
                <div className="flex min-w-0 items-center gap-2 font-semibold text-white">
                  <LayoutGrid className="h-4 w-4 text-white/50" />
                  <span className="truncate">All Generations</span>
                </div>
              ) : rightTab === "favorites" ? (
                <div className="flex min-w-0 items-center gap-2 font-semibold text-white">
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
                  setNavigationOpen(drawer);
                  setAddingScope({
                    projectId: activeProjectId,
                    parentId: activeFolderId === UNSORTED ? null : activeFolderId,
                  });
                }}
                className="flex items-center gap-1.5 rounded-md bg-white/10 px-2.5 py-1 text-xs font-medium text-white transition hover:bg-white/15"
                disabled={maintenance}
                title="Create new folder"
              >
                <FolderPlus className="h-3.5 w-3.5" />
                <span>+ New folder</span>
              </button>
            </div>
          </div>

          {/* ── ROW 2: ASSET COMMAND BAR WITH IN-PLACE CONTEXTUAL SELECTION (44px; taller in the drawer, see globals.css) ── */}
          {selectedIds.length > 0 ? (
            /* Selection Mode: In-Place Swap (ZERO vertical jump, EXACT same height as the search row).
               Narrow panels drop labels instead of wrapping (see globals.css). */
            <div
              data-testid="selection-toolbar"
              className="selection-toolbar flex h-11 shrink-0 items-center justify-between gap-2 border-b border-line bg-ink-800/90 px-4 text-xs select-none"
            >
              {/* Left: Select all & count */}
              <div className="flex min-w-0 items-center gap-2.5">
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={allSelected}
                  aria-label="Select all"
                  title={allSelected ? "Deselect all" : "Select all"}
                  onClick={() => (allSelected ? clearSelection() : selectAll(itemIds))}
                  className={cn(
                    "grid h-4 w-4 shrink-0 place-items-center rounded border transition",
                    allSelected
                      ? "border-brand bg-brand text-ink-900"
                      : "border-white/40 text-transparent hover:border-white"
                  )}
                >
                  <Check className="h-3 w-3" strokeWidth={3} />
                </button>

                <span className="truncate font-semibold text-white">
                  {selectedIds.length}<span className="selection-count-label"> selected</span>
                </span>
              </div>

              {/* Right: Contextual actions */}
              <div className="selection-actions flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  onClick={downloadSelectedZip}
                  disabled={maintenance || !selectedExportableIds.length || isDownloadingZip}
                  className="selection-action flex h-6 items-center gap-1.5 rounded-full bg-brand/20 font-semibold text-brand transition hover:bg-brand/30 disabled:cursor-not-allowed disabled:opacity-40"
                  aria-label="Download ZIP"
                  title="Download selected items as ZIP"
                >
                  {isDownloadingZip ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Download className="h-3.5 w-3.5" />
                  )}
                  <span className="selection-zip-label">Download ZIP</span>
                </button>

                {isAdmin && (<button
                  type="button"
                  disabled={maintenance}
                  onClick={() => setMoveModalOpen(true)}
                  className="selection-action flex h-6 items-center gap-1.5 rounded-full bg-brand/20 font-semibold text-brand transition hover:bg-brand/30"
                  aria-label="Move"
                  title="Move selected items"
                >
                  <Move className="h-3.5 w-3.5" />
                  <span className="selection-move-label">Move</span>
                </button>)}

                {/* More Actions Dropdown */}
                {isAdmin && (<Dropdown
                  align="right"
                  maintenanceWrite
                  label="More actions"
                  trigger={(open) => (
                    <span
                      title="More actions"
                      className={cn(
                        "grid h-6 w-6 place-items-center rounded-full border border-line bg-ink-700/80 text-white/75 transition hover:text-white",
                        open && "border-brand/40 text-white"
                      )}
                    >
                      <MoreHorizontal className="h-3.5 w-3.5" />
                    </span>
                  )}
                >
                  {(close) => (
                    <div className="py-1 min-w-[150px]">
                      {project && (
                        <MenuItem
                          onClick={() => {
                            close();
                            moveGenerationsToDestination(selectedIds, { type: "global_root" })
                              .catch((err) => notify(err.message || "Failed to move items."));
                          }}
                        >
                          <span>Remove from Project</span>
                        </MenuItem>
                      )}
                      <MenuItem
                        onClick={async () => {
                          close();
                          if (
                            await askConfirm({ title: `Delete ${selectedIds.length} ${selectedIds.length === 1 ? "item" : "items"}?`, description: "This can't be undone.", confirmLabel: "Delete", destructive: true })
                          ) {
                            try { await deleteGenerations(selectedIds); }
                            catch (err) { notify(err.message || "Failed to delete items."); }
                          }
                        }}
                        className="text-red-400 hover:text-red-300"
                      >
                        <Trash2 className="h-3.5 w-3.5 text-red-400" />
                        <span>Delete</span>
                      </MenuItem>
                    </div>
                  )}
                </Dropdown>)}

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
            /* The drawer gives search its own row (globals.css); the sidebar layout keeps the compact command bar. */
            <div className="history-search-row flex h-11 shrink-0 items-center justify-between gap-3 border-b border-line bg-ink-850 px-4 select-none">
              {/* Search Input (max-w ~380px) */}
              <div className="history-search relative min-w-0 w-full max-w-md">
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
                  placeholder="Search prompts…"
                  aria-label="Search prompts"
                  className={cn(
                    "w-full text-ellipsis rounded-full border border-line bg-ink-700/80 py-1 pl-8 text-xs text-white/90 outline-none transition placeholder:text-white/35 focus:border-brand/40 focus:bg-ink-650",
                    // Reserve the clear/refresh slot only when it is shown, so a narrow toolbar keeps the placeholder whole.
                    searchDraft || refreshing ? "pr-8" : "pr-3"
                  )}
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
              <div className="history-view-controls flex shrink-0 items-center justify-end gap-2">
                <LibraryFilters />

                {/* View Dropdown (Thumbnail Size Slider) */}
                <Dropdown
                  align="right"
                  label="View settings"
                  trigger={(open) => (
                    <span
                      className={cn(
                        "history-view-trigger flex items-center gap-1.5 rounded-full border border-line bg-ink-700/80 px-3 py-1 text-xs text-white/75 transition hover:text-white",
                        open && "border-brand/40 text-white"
                      )}
                    >
                      <SlidersHorizontal className="h-3 w-3" />
                      <span>View</span>
                      <ChevronDown
                        className={cn("h-3 w-3 transition-transform", open && "rotate-180")}
                      />
                    </span>
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
                      <div className="border-t border-line pt-2">
                        <label className="block text-[10px] font-semibold uppercase tracking-wider text-white/40" htmlFor={`${navigationId}-sort`}>Sort by</label>
                        <select id={`${navigationId}-sort`} aria-label="Sort library" value={sort} onChange={(event) => setLibrarySort(event.target.value)} className="mt-2 w-full rounded-lg border border-line bg-ink-800 px-2 py-2 text-xs text-white/80">
                          <option value="newest">Newest first</option><option value="oldest">Oldest first</option>
                          {rightTab === "favorites" && <option value="starred">Recently starred</option>}
                        </select>
                        <label className="mt-3 flex items-center gap-2 text-xs text-white/70"><input type="checkbox" className="accent-white" checked={groupByDate && sort !== "starred"} disabled={sort === "starred"} onChange={event => setGroupByDate(event.target.checked)} />Group by date</label>
                        {sort === "starred" && <p className="mt-2 text-[10px] leading-4 text-white/40">Date grouping is off while sorted by when starred.</p>}
                      </div>
                    </div>
                  )}
                </Dropdown>
              </div>
            </div>
          )}

          {!briefView && <><LibraryFilterChips /><LibraryResultsAnnouncer /></>}
          {!briefView && feedError && items.length > 0 && <div role="alert" className="flex flex-wrap items-center gap-2 px-4 pt-3 text-xs text-white/60">Could not update the library.<button type="button" className="underline" onClick={() => loadFeed({ force: true })}>Retry</button></div>}

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
                groupByDate={groupByDate && sort !== "starred"}
                empty={
                  filtering ? <LibraryNoMatches /> : rightTab === "favorites" ? (
                    <EmptyState
                      icon={<Star className="h-6 w-6 text-amber-300/70" />}
                      title="No favourites yet"
                      body="Star your best generations and they collect here, newest first."
                    />
                  ) : (
                    <EmptyState
                      icon={<HistoryIcon className="h-6 w-6" />}
                      title="Nothing generated yet"
                      body="Every image and video generated appears here."
                    />
                  )
                }
                renderItem={(item) => <MediaCard key={item.id} item={item} selectable />}
              />
            )}
          </div>
        </main>
      </div>

      {/* ══════════════════════════════════════════════════════════════════════
          FLOATING ANCHORED ZIP PROGRESS TOAST (BOTTOM-RIGHT, NEVER PUSHES GRID)
          ══════════════════════════════════════════════════════════════════════ */}
      {displayedExport && (
        <div
          role="status"
          aria-label="ZIP export"
          aria-live="polite"
          className="fixed bottom-5 right-5 left-5 sm:left-auto z-50 max-w-[calc(100vw-2.5rem)] flex-wrap flex items-center gap-3 rounded-xl border border-line bg-ink-750/95 px-4 py-2.5 shadow-2xl backdrop-blur-xl text-xs text-white select-none animate-in fade-in slide-in-from-bottom-2 duration-200"
        >
          {["queued", "running"].includes(displayedExport.status) && (
            <>
              <Loader2 className="h-4 w-4 animate-spin text-brand" />
              <span>
                {displayedExport.status === "queued"
                  ? "ZIP queued…"
                  : `Building ZIP ${displayedExport.processedItems} / ${displayedExport.totalItems}`}
                {displayedExport.skippedItems ? ` · ${displayedExport.skippedItems} skipped` : ""}
              </span>
            </>
          )}
          {displayedExport.status === "ready" && (
            <>
              <Check className="h-4 w-4 text-emerald-400" />
              <span>
                ZIP ready{displayedExport.skippedItems ? ` · ${displayedExport.skippedItems} skipped` : ""}
              </span>
              <a
                href={`/api/history/exports/${displayedExport.id}/download`}
                onClick={downloadExport}
                download
                className="font-semibold text-brand hover:underline"
              >
                Download
              </a>
            </>
          )}
          {["failed", "expired"].includes(displayedExport.status) && (
            <>
              <AlertCircle className="h-4 w-4 text-rose-400" />
              <span className="text-rose-300">{displayedExport.error || "ZIP export failed."}</span>
              {displayedExport.status === "failed" && displayedExport.id && displayedExport.canRetry !== false && <button
                type="button"
                disabled={maintenance || isDownloadingZip}
                onClick={retryExport}
                className="font-semibold text-brand hover:underline"
              >
                Retry
              </button>}
            </>
          )}
          {displayedExport.pollError && <span className="text-amber-300">{displayedExport.pollError}</span>}
          {displayedExport.downloadError && <span className="text-rose-300">{displayedExport.downloadError}</span>}
          <button
            type="button"
            onClick={() => {
              try {
                localStorage.removeItem(exportStorageKey);
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
      <iframe ref={downloadFrame} hidden title="ZIP download response" onLoad={() => {
        // Local API errors remain readable; cross-origin attachment grants never
        // enter persisted state and cannot navigate or open a tab over the app.
        try {
          const text = downloadFrame.current.contentDocument?.body?.textContent;
          const response = text ? JSON.parse(text) : null;
          if (response?.error) setActiveExport((value) => value?.actorId === actorId
            ? { ...value, downloadError: "ZIP download is unavailable. Try again or create a new ZIP." } : value);
        } catch {}
      }} />

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
