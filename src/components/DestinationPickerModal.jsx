"use client";

import { useEffect, useMemo, useState } from "react";
import {
  FolderClosed,
  FolderOpen,
  Layers,
  Inbox,
  ChevronRight,
  ChevronDown,
  Search,
  X,
  Loader2,
  AlertCircle,
} from "lucide-react";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";

/**
 * Collect all descendant IDs for a given folder from a tree structure.
 */
function getDescendantIds(folders, targetId) {
  const descendants = new Set();
  function search(list, insideTarget) {
    for (const f of list) {
      const isTarget = f.id === targetId;
      if (insideTarget || isTarget) {
        if (!isTarget) descendants.add(f.id);
        if (f.children?.length) {
          search(f.children, true);
        }
      } else if (f.children?.length) {
        search(f.children, false);
      }
    }
  }
  search(folders, false);
  return descendants;
}

export function DestinationPickerModal({
  open,
  onClose,
  title = "Move to...",
  movingFolderId = null,
  movingFolderCurrentParentId = null,
  onConfirm,
}) {
  const libraryTree = useStore((s) => s.libraryTree);
  const loadLibraryTree = useStore((s) => s.loadLibraryTree);
  const [selectedDest, setSelectedDest] = useState(null);
  const [filterQuery, setFilterQuery] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [expandedNodes, setExpandedNodes] = useState({});

  useEffect(() => {
    if (open) {
      loadLibraryTree();
      setSelectedDest(null);
      setError(null);
      setFilterQuery("");
    }
  }, [open, loadLibraryTree]);

  // Compute invalid folder destinations if we are moving a folder (no self or descendants)
  const forbiddenFolderIds = useMemo(() => {
    if (!movingFolderId) return new Set();
    const set = new Set([movingFolderId]);
    const allRoots = [
      ...(libraryTree?.globalFolders ?? []),
      ...(libraryTree?.projects?.flatMap((p) => p.folders ?? []) ?? []),
    ];
    const descendants = getDescendantIds(allRoots, movingFolderId);
    for (const d of descendants) set.add(d);
    return set;
  }, [movingFolderId, libraryTree]);

  if (!open) return null;

  const toggleExpand = (id, e) => {
    e?.stopPropagation();
    setExpandedNodes((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const isFolderValid = (folder) => {
    if (!movingFolderId) return true;
    if (forbiddenFolderIds.has(folder.id)) return false;
    if (folder.id === movingFolderCurrentParentId) return false;
    return true;
  };

  const handleSelect = (dest) => {
    setSelectedDest(dest);
    setError(null);
  };

  const handleSubmit = async () => {
    if (!selectedDest) return;
    setSubmitting(true);
    setError(null);
    try {
      await onConfirm(selectedDest);
      onClose();
    } catch (err) {
      setError(err?.message || "Failed to move to destination.");
    } finally {
      setSubmitting(false);
    }
  };

  const renderFolderItem = (folder, depth = 0) => {
    const isSelected =
      selectedDest?.type === "folder" && selectedDest?.folderId === folder.id;
    const isValid = isFolderValid(folder);
    const hasChildren = folder.children && folder.children.length > 0;
    const isExpanded = Boolean(expandedNodes[folder.id]);

    const matchesFilter =
      !filterQuery.trim() ||
      folder.name.toLowerCase().includes(filterQuery.toLowerCase());

    return (
      <div key={folder.id} className="flex flex-col">
        {matchesFilter && (
          <div
            onClick={() => isValid && handleSelect({ type: "folder", folderId: folder.id, projectId: folder.projectId })}
            style={{ paddingLeft: `${depth * 1.25 + 0.5}rem` }}
            className={cn(
              "group flex items-center gap-1.5 rounded-lg py-1.5 pr-3 text-xs transition select-none cursor-pointer",
              isSelected
                ? "bg-brand/20 text-brand font-medium"
                : isValid
                ? "text-white/80 hover:bg-white/5 hover:text-white"
                : "text-white/25 cursor-not-allowed"
            )}
          >
            {hasChildren ? (
              <button
                type="button"
                onClick={(e) => toggleExpand(folder.id, e)}
                className="grid h-4 w-4 place-items-center text-white/40 hover:text-white"
              >
                {isExpanded ? (
                  <ChevronDown className="h-3.5 w-3.5" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5" />
                )}
              </button>
            ) : (
              <span className="w-4" />
            )}

            {isExpanded ? (
              <FolderOpen className={cn("h-4 w-4 shrink-0", isSelected ? "text-brand" : "text-amber-400/80")} />
            ) : (
              <FolderClosed className={cn("h-4 w-4 shrink-0", isSelected ? "text-brand" : "text-amber-400/80")} />
            )}

            <span className="flex-1 truncate">{folder.name}</span>

            {!isValid && movingFolderId && (
              <span className="text-[10px] text-white/30 italic">
                {forbiddenFolderIds.has(folder.id) ? "(descendant)" : "(current parent)"}
              </span>
            )}
          </div>
        )}

        {hasChildren && isExpanded && (
          <div className="flex flex-col">
            {folder.children.map((child) => renderFolderItem(child, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="destination-picker-title"
        className="flex max-h-[85vh] w-full max-w-md flex-col rounded-2xl border border-line bg-ink-900 shadow-2xl overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <h2 id="destination-picker-title" className="text-sm font-semibold text-white">
            {title}
          </h2>
          <button
            onClick={onClose}
            className="grid h-7 w-7 place-items-center rounded-lg text-white/50 transition hover:bg-white/10 hover:text-white"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Search */}
        <div className="border-b border-line px-4 py-2.5">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-white/35" />
            <input
              type="text"
              value={filterQuery}
              onChange={(e) => setFilterQuery(e.target.value)}
              placeholder="Search folders..."
              className="w-full rounded-lg border border-line bg-ink-800 py-1.5 pl-8 pr-3 text-xs text-white placeholder:text-white/35 outline-none focus:border-brand/40"
            />
          </div>
        </div>

        {/* Error Alert */}
        {error && (
          <div className="flex items-center gap-2 border-b border-red-500/20 bg-red-500/10 px-4 py-2 text-xs text-red-300">
            <AlertCircle className="h-4 w-4 shrink-0 text-red-400" />
            <span>{error}</span>
          </div>
        )}

        {/* Tree Container */}
        <div className="scroll-thin min-h-[240px] max-h-[380px] overflow-y-auto p-3 space-y-4">
          {/* Global Library Section */}
          <div className="space-y-1">
            <div className="flex items-center justify-between px-2 py-1">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-white/40">
                Global Library
              </span>
            </div>

            {/* Global Root Target */}
            <div
              onClick={() => handleSelect({ type: "global_root" })}
              className={cn(
                "flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs transition cursor-pointer select-none",
                selectedDest?.type === "global_root"
                  ? "bg-brand/20 text-brand font-medium"
                  : "text-white/80 hover:bg-white/5 hover:text-white"
              )}
            >
              <Layers className="h-4 w-4 text-white/50" />
              <span>Global Library Root</span>
            </div>

            {/* Global Unsorted Target (generations only) */}
            {!movingFolderId && (
              <div
                onClick={() => handleSelect({ type: "global_unsorted" })}
                className={cn(
                  "flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs transition cursor-pointer select-none",
                  selectedDest?.type === "global_unsorted"
                    ? "bg-brand/20 text-brand font-medium"
                    : "text-white/80 hover:bg-white/5 hover:text-white"
                )}
              >
                <Inbox className="h-4 w-4 text-white/50" />
                <span>Global Unsorted</span>
              </div>
            )}

            {/* Global Folders Tree */}
            <div className="pt-1">
              {(libraryTree?.globalFolders ?? []).map((folder) =>
                renderFolderItem(folder, 0)
              )}
            </div>
          </div>

          {/* Projects Section */}
          {(libraryTree?.projects ?? []).length > 0 && (
            <div className="border-t border-line/60 pt-3 space-y-2">
              <div className="px-2 py-1">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-white/40">
                  Projects
                </span>
              </div>

              {(libraryTree.projects).map((proj) => (
                <div key={proj.id} className="space-y-0.5 rounded-lg bg-ink-800/40 p-1.5">
                  {/* Project Root Destination */}
                  <div
                    onClick={() => handleSelect({ type: "project_root", projectId: proj.id })}
                    className={cn(
                      "flex items-center gap-2 rounded-md px-2 py-1.5 text-xs transition cursor-pointer select-none",
                      selectedDest?.type === "project_root" && selectedDest?.projectId === proj.id
                        ? "bg-brand/20 text-brand font-medium"
                        : "text-white/85 hover:bg-white/5 hover:text-white"
                    )}
                  >
                    <Layers className="h-4 w-4 text-brand/70" />
                    <span className="font-medium truncate">{proj.name} (Root)</span>
                  </div>

                  {/* Project Unsorted (generations only) */}
                  {!movingFolderId && (
                    <div
                      onClick={() => handleSelect({ type: "project_unsorted", projectId: proj.id })}
                      className={cn(
                        "flex items-center gap-2 rounded-md px-2 py-1.5 text-xs transition cursor-pointer select-none",
                        selectedDest?.type === "project_unsorted" && selectedDest?.projectId === proj.id
                          ? "bg-brand/20 text-brand font-medium"
                          : "text-white/70 hover:bg-white/5 hover:text-white"
                      )}
                    >
                      <Inbox className="h-3.5 w-3.5 text-white/40" />
                      <span>{proj.name} Unsorted</span>
                    </div>
                  )}

                  {/* Project Folders Tree */}
                  <div className="pt-0.5">
                    {(proj.folders ?? []).map((folder) =>
                      renderFolderItem(folder, 0)
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className="flex items-center justify-between border-t border-line px-5 py-3.5 bg-ink-850">
          <div className="text-xs text-white/50 truncate max-w-[220px]">
            {selectedDest ? (
              <span>
                Selected:{" "}
                <strong className="text-white">
                  {selectedDest.type === "global_root"
                    ? "Global Library Root"
                    : selectedDest.type === "global_unsorted"
                    ? "Global Unsorted"
                    : selectedDest.type === "project_root"
                    ? "Project Root"
                    : selectedDest.type === "project_unsorted"
                    ? "Project Unsorted"
                    : "Folder"}
                </strong>
              </span>
            ) : (
              "Select a destination"
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg px-3 py-1.5 text-xs font-medium text-white/70 hover:bg-white/10 hover:text-white transition"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!selectedDest || submitting}
              onClick={handleSubmit}
              className="flex items-center gap-1.5 rounded-lg bg-brand px-4 py-1.5 text-xs font-semibold text-ink-950 transition hover:bg-brand/90 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {submitting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Move
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
