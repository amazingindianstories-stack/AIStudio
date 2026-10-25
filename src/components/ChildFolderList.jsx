"use client";

import { useMemo, useState, useRef, useEffect } from "react";
import { notify } from "@/lib/notify";
import {
  FolderClosed,
  ChevronRight,
  ChevronDown,
  MoreVertical,
  Pencil,
  Move,
  Trash2,
} from "lucide-react";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { Dropdown, MenuItem } from "./Dropdown";
import { isFolderOperationBusy } from "./FolderTree";
import { RenameFolderGenerationsItem } from "./RenameFolderGenerationsItem";
import { InlineFolderNameEditor } from "./InlineFolderNameEditor";
import {
  getAssetDragData,
  setFolderDragData,
  getFolderDragData,
  isFolderDragEvent,
  clearFolderDragData,
  isFolderDescendant,
} from "@/lib/asset-drag-contract";
import {
  getFolderColorClass,
  FOLDER_COLOR_OPTIONS,
} from "@/lib/folder-colors";
import { askConfirm } from "@/lib/ask-text";

const FOLDERS_EXPANDED_KEY = "veevee_folders_expanded";

export function ChildFolderList({
  parentId = null,
  projectId = null,
  onOpenMoveModal,
  onOpenNewFolderModal: _onOpenNewFolderModal,
}) {
  const isAdmin = useStore((s) => s.currentUser?.role === "admin");
  const operations = useStore((s) => s.operations);
  const actorId = useStore((s) => s.currentUser?.id);
  const preferenceKey = `${FOLDERS_EXPANDED_KEY}:${actorId || "anonymous"}`;
  const libraryTree = useStore((s) => s.libraryTree);
  const counts = useStore((s) => s.counts);
  const setActiveFolder = useStore((s) => s.setActiveFolder);
  const renameFolder = useStore((s) => s.renameFolder);
  const deleteFolder = useStore((s) => s.deleteFolder);
  const moveFolder = useStore((s) => s.moveFolder);
  const setFolderColor = useStore((s) => s.setFolderColor);
  const moveGenerationsToDestination = useStore((s) => s.moveGenerationsToDestination);

  const [expanded, setExpanded] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [dragOverFolderId, setDragOverFolderId] = useState(null);
  const [dragOverFolderValid, setDragOverFolderValid] = useState(true);
  const dragCounterMap = useRef(new Map());
  const [renamingFolderId, setRenamingFolderId] = useState(null);

  // Restore expanded state from localStorage (default collapsed)
  useEffect(() => {
    try {
      const stored = localStorage.getItem(preferenceKey);
      setExpanded(stored === "true");
      setHidden(localStorage.getItem(`${preferenceKey}:hidden`) === "true");
    } catch {
      /* ignore */
    }
  }, [preferenceKey]);

  const toggleHidden = () => {
    setHidden((previous) => { const next = !previous; try { localStorage.setItem(`${preferenceKey}:hidden`, String(next)); } catch {} return next; });
  };
  const toggleExpanded = () => {
    setExpanded((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(preferenceKey, String(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  };

  // All folders across global + projects for ancestor cycle checks
  const allTreeFolders = useMemo(() => {
    return [
      ...(libraryTree?.globalFolders ?? []),
      ...(libraryTree?.projects?.flatMap((p) => p.folders ?? []) ?? []),
    ];
  }, [libraryTree]);

  // Find immediate child folders from libraryTree
  const childFolders = useMemo(() => {
    if (!libraryTree) return [];

    function findNode(nodes, id) {
      for (const n of nodes) {
        if (n.id === id) return n;
        if (n.children?.length) {
          const found = findNode(n.children, id);
          if (found) return found;
        }
      }
      return null;
    }

    if (parentId) {
      const allRoots = [
        ...(libraryTree.globalFolders ?? []),
        ...(libraryTree.projects?.flatMap((p) => p.folders ?? []) ?? []),
      ];
      const node = findNode(allRoots, parentId);
      return node?.children ?? [];
    }

    if (projectId) {
      const proj = libraryTree.projects?.find((p) => p.id === projectId);
      return (proj?.folders ?? []).filter((f) => !f.parentId);
    }

    return (libraryTree.globalFolders ?? []).filter((f) => !f.parentId);
  }, [libraryTree, parentId, projectId]);

  // If 0 child folders, do not render at all
  if (!childFolders || childFolders.length === 0) {
    return null;
  }

  const isDropTargetValid = (targetFolderId, e) => {
    if (!isAdmin && !isFolderDragEvent(e) && !getFolderDragData(e)) return false;
    const draggedFolderId = getFolderDragData(e);
    if (draggedFolderId) {
      if (draggedFolderId === targetFolderId) return false;
      if (isFolderDescendant(allTreeFolders, draggedFolderId, targetFolderId)) return false;
    }
    return true;
  };

  const handleDragEnter = (id) => (e) => {
    dragCounterMap.current.set(id, (dragCounterMap.current.get(id) || 0) + 1);
    const valid = isDropTargetValid(id, e);
    setDragOverFolderId(id);
    setDragOverFolderValid(valid);
  };

  const handleDragOver = (id) => (e) => {
    e.preventDefault();
    e.stopPropagation();
    const valid = isDropTargetValid(id, e);
    e.dataTransfer.dropEffect = valid ? "move" : "none";
    if (dragOverFolderId !== id) setDragOverFolderId(id);
    if (dragOverFolderValid !== valid) setDragOverFolderValid(valid);
  };

  const handleDragLeave = (id) => (e) => {
    e.preventDefault();
    e.stopPropagation();
    const count = Math.max(0, (dragCounterMap.current.get(id) || 0) - 1);
    dragCounterMap.current.set(id, count);
    if (count === 0 && dragOverFolderId === id) {
      setDragOverFolderId(null);
      setDragOverFolderValid(true);
    }
  };

  const handleDropOnFolder = (targetFolderId) => (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterMap.current.clear();
    setDragOverFolderId(null);
    setDragOverFolderValid(true);

    const assetPayload = getAssetDragData(e, useStore.getState());
    const draggedFolderId = getFolderDragData(e);

    if (assetPayload.ids.length > 0) {
      if (!isAdmin) return;
      moveGenerationsToDestination(assetPayload.ids, {
        type: "folder",
        folderId: targetFolderId,
        ...(projectId ? { projectId } : {}),
      }).catch((err) => {
        notify(err.message || "Failed to move items.");
      });
    } else if (draggedFolderId && draggedFolderId !== targetFolderId) {
      if (isFolderDescendant(allTreeFolders, draggedFolderId, targetFolderId)) {
        notify("Cannot move a folder into its own subfolder.");
        return;
      }
      moveFolder(draggedFolderId, { type: "folder", folderId: targetFolderId }).catch((err) => {
        notify(err.message || "Failed to move folder.");
      });
    }
  };

  const getFolderCount = (fId) => {
    if (projectId) {
      return counts.project?.byFolder?.[fId] ?? 0;
    }
    return counts.globalLibrary?.byFolder?.[fId] ?? 0;
  };

  return (
    <div className="border-b border-line bg-ink-900/60 select-none">
      <div className="flex items-center">
      {hidden ? <button type="button" aria-label="Show folders" onClick={toggleHidden} className="h-8 px-4 text-xs text-white/60 hover:text-white">Show folders ({childFolders.length})</button> : <>
      {/* Collapsible Section Header (approx 32-36px high) */}
      <button
        type="button"
        onClick={toggleExpanded}
        aria-label={expanded ? "Collapse folders" : "Expand folders"}
        aria-expanded={expanded}
        className="flex h-8 flex-1 items-center gap-1.5 px-4 text-xs font-medium text-white/60 transition hover:bg-white/5 hover:text-white"
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 text-white/50" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-white/50" />
        )}
        <span className="text-white/80">Folders</span>
        <span className="rounded-full bg-white/10 px-1.5 py-0.2 text-[10px] tabular-nums text-white/60">
          {childFolders.length}
        </span>
      </button>
      <button type="button" aria-label="Hide folders" onClick={toggleHidden} className="shrink-0 px-3 text-xs text-white/50 hover:text-white">Hide folders</button>
      </>}
      </div>

      {/* Expanded Compact Folder Tiles */}
      {!hidden && expanded && (
        <div
          data-testid="child-folder-list"
          style={{ gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 160px), 1fr))" }}
          className="grid min-w-0 max-h-64 gap-2 overflow-y-auto overscroll-contain p-3 pt-1 border-t border-line/40 scroll-thin"
        >
          {childFolders.map((folder) => {
            const busy = isFolderOperationBusy(operations, folder.id);
            const count = getFolderCount(folder.id);
            const isDragOver = dragOverFolderId === folder.id;
            const glyphColorClass = getFolderColorClass(folder.color);

            return (
              <div
                key={folder.id}
                role="button"
                tabIndex={0}
                title={folder.name}
                onKeyDown={(e) => { if (e.target === e.currentTarget && ["Enter", " "].includes(e.key)) { e.preventDefault(); setActiveFolder(folder.id); } }}
                aria-busy={busy}
                draggable={renamingFolderId !== folder.id && !busy}
                onDragStart={(e) => {
                  setFolderDragData(e.dataTransfer, folder.id, folder.name);
                }}
                onDragEnd={() => {
                  clearFolderDragData();
                }}
                onDragEnter={handleDragEnter(folder.id)}
                onDragOver={handleDragOver(folder.id)}
                onDragLeave={handleDragLeave(folder.id)}
                onDrop={handleDropOnFolder(folder.id)}
                onClick={() => setActiveFolder(folder.id)}
                className={cn(
                  "group relative flex h-11 items-center gap-2 rounded-lg border border-line bg-ink-800/80 px-2.5 py-1.5 transition hover:border-white/20 hover:bg-ink-750 cursor-pointer select-none min-w-0",
                  isDragOver &&
                    (dragOverFolderValid
                      ? "border-brand bg-brand/10 ring-1 ring-brand text-brand"
                      : "border-red-500/80 bg-red-500/10 text-red-300 ring-1 ring-red-500/40 cursor-not-allowed")
                )}
              >
                {/* Folder icon with custom color token */}
                <FolderClosed className={cn("h-4 w-4 shrink-0 transition", glyphColorClass)} />

                {/* Name & Count */}
                <div className="min-w-0 flex-1 overflow-hidden">
                  {renamingFolderId === folder.id ? (
                    <InlineFolderNameEditor
                      initialName={folder.name}
                      label="Rename folder"
                      onCommit={(name) => renameFolder(folder.projectId, folder.id, name)}
                      onClose={() => setRenamingFolderId(null)}
                    />
                  ) : (
                    <p className="truncate text-xs font-medium text-white/90 group-hover:text-white leading-tight">
                      {folder.name}
                    </p>
                  )}
                  <p className="text-[10px] text-white/40 tabular-nums leading-tight">
                    {count} {count === 1 ? "asset" : "assets"}
                  </p>
                </div>

                {/* Hover Context Menu */}
                <div inert={busy ? true : undefined} onClick={(e) => e.stopPropagation()} className="relative shrink-0">
                  <Dropdown
                    label={`Card folder actions: ${folder.name}`}
                    align="right"
                    trigger={(open) => (
                      <span
                        className={cn(
                          "grid h-5 w-5 place-items-center rounded text-white/40 opacity-60 group-hover:opacity-100 group-focus-within:opacity-100 transition hover:bg-white/10 hover:text-white",
                          open && "opacity-100 bg-white/10 text-white"
                        )}
                      >
                        <MoreVertical className="h-3 w-3" />
                      </span>
                    )}
                  >
                    {(close) => (
                      <div className="py-1 min-w-[160px]">
                        {/* Finder-style Color Picker Palette */}
                        <div className="px-2.5 py-1.5 border-b border-line">
                          <span className="text-[10px] font-semibold uppercase tracking-wider text-white/40 block mb-1.5">
                            Color
                          </span>
                          <div className="flex items-center gap-1.5 flex-wrap">
                            {FOLDER_COLOR_OPTIONS.map((opt) => (
                              <button
                                key={opt.id}
                                type="button"
                                title={opt.label}
                                aria-label={`${opt.label} folder color`}
                                aria-pressed={(folder.color || "default") === opt.id}
                                onClick={() => {
                                  close();
                                  setFolderColor(folder.id, opt.id === "default" ? null : opt.id);
                                }}
                                className={cn(
                                  "grid h-4 w-4 place-items-center rounded-full transition hover:scale-125",
                                  (folder.color || "default") === opt.id &&
                                    "ring-2 ring-white ring-offset-1 ring-offset-ink-750"
                                )}
                              >
                                <span className={cn("h-2.5 w-2.5 rounded-full", opt.dotClass)} />
                              </button>
                            ))}
                          </div>
                        </div>

                        <MenuItem
                          onClick={() => {
                            close({ restoreFocus: false });
                            setRenamingFolderId(folder.id);
                          }}
                        >
                          <Pencil className="h-3.5 w-3.5 text-white/50" />
                          <span>Rename</span>
                        </MenuItem>

                        {onOpenMoveModal && (
                          <MenuItem
                            onClick={() => {
                              close({ restoreFocus: false });
                              onOpenMoveModal(folder);
                            }}
                          >
                            <Move className="h-3.5 w-3.5 text-white/50" />
                            <span>Move...</span>
                          </MenuItem>
                        )}

                        <RenameFolderGenerationsItem folder={folder} close={close} />
                  {isAdmin && <div className="my-1 h-px bg-line" />}

                        {isAdmin && (<MenuItem
                          onClick={async () => {
                            close();
                            if (
                              await askConfirm({ title: `Delete folder "${folder.name}"?`, description: "Only empty folders can be deleted.", confirmLabel: "Delete", destructive: true })
                            ) {
                              deleteFolder(folder.projectId, folder.id).catch((err) => {
                                notify(err.message || "Failed to delete folder.");
                              });
                            }
                          }}
                          className="text-red-400 hover:text-red-300"
                        >
                          <Trash2 className="h-3.5 w-3.5 text-red-400" />
                          <span>Delete</span>
                        </MenuItem>)}
                      </div>
                    )}
                  </Dropdown>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
