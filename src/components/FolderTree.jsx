"use client";

import { useMaintenance } from "@/lib/maintenance-client";

import { useEffect, useId, useRef, useState } from "react";
import { notify } from "@/lib/notify";
import {
  ChevronRight,
  ChevronDown,
  FolderClosed,
  FolderOpen,
  FolderPlus,
  MoreVertical,
  Pencil,
  Move,
  Trash2,
  Loader2,
} from "lucide-react";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { Dropdown, MenuItem } from "./Dropdown";
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

export function FolderTree({
  folders = [],
  activeFolderId = null,
  countsByFolder = {},
  projectId = null,
  onSelectFolder,
  onOpenMoveModal,
  onOpenNewFolderModal,
}) {
  const maintenance = useMaintenance((s) => s.enabled);
  const isAdmin = useStore((s) => s.currentUser?.role === "admin");
  const [expanded, setExpanded] = useState({});
  const [dragOverId, setDragOverId] = useState(null);
  const [dragOverValid, setDragOverValid] = useState(true);
  const dragCounterMap = useRef(new Map());
  const [renamingFolderId, setRenamingFolderId] = useState(null);
  const renameFolder = useStore((s) => s.renameFolder);
  const deleteFolder = useStore((s) => s.deleteFolder);
  const moveFolder = useStore((s) => s.moveFolder);
  const setFolderColor = useStore((s) => s.setFolderColor);
  const moveGenerationsToDestination = useStore((s) => s.moveGenerationsToDestination);

  const operations = useStore((s) => s.operations);
  const treeId = useId();
  const treeRef = useRef(null);

  useEffect(() => {
    const ancestors = (nodes, path = []) => {
      for (const node of nodes) {
        if (node.id === activeFolderId) return path;
        const found = ancestors(node.children || [], [...path, node.id]);
        if (found) return found;
      }
      return null;
    };
    const path = ancestors(folders);
    if (path?.length) setExpanded((previous) => ({ ...previous, ...Object.fromEntries(path.map((id) => [id, true])) }));
  }, [folders, activeFolderId]);

  const toggleExpand = (id, e) => {
    e?.stopPropagation();
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const isDropTargetValid = (targetFolderId, e) => {
    if (maintenance) return false;
    if (!isAdmin && !isFolderDragEvent(e) && !getFolderDragData(e)) return false;
    const draggedFolderId = getFolderDragData(e);
    if (draggedFolderId) {
      if (draggedFolderId === targetFolderId) return false;
      if (isFolderDescendant(folders, draggedFolderId, targetFolderId)) return false;
    }
    return true;
  };

  const handleDragEnter = (id) => (e) => {
    dragCounterMap.current.set(id, (dragCounterMap.current.get(id) || 0) + 1);
    const valid = isDropTargetValid(id, e);
    setDragOverId(id);
    setDragOverValid(valid);
  };

  const handleDragOver = (id) => (e) => {
    e.preventDefault();
    e.stopPropagation();
    const valid = isDropTargetValid(id, e);
    e.dataTransfer.dropEffect = valid ? "move" : "none";
    if (dragOverId !== id) setDragOverId(id);
    if (dragOverValid !== valid) setDragOverValid(valid);
  };

  const handleDragLeave = (id) => (e) => {
    e.preventDefault();
    e.stopPropagation();
    const count = Math.max(0, (dragCounterMap.current.get(id) || 0) - 1);
    dragCounterMap.current.set(id, count);
    if (count === 0 && dragOverId === id) {
      setDragOverId(null);
      setDragOverValid(true);
    }
  };

  const handleDrop = (targetFolderId) => (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterMap.current.clear();
    setDragOverId(null);
    setDragOverValid(true);

    if (maintenance) return;
    const assetPayload = getAssetDragData(e, useStore.getState());
    const draggedFolderId = getFolderDragData(e);

    if (assetPayload.ids.length > 0) {
      if (!isAdmin) return;
      moveGenerationsToDestination(assetPayload.ids, {
        type: "folder",
        folderId: targetFolderId,
        projectId,
      }).catch((err) => {
        notify(err.message || "Failed to move items.");
      });
    } else if (draggedFolderId && draggedFolderId !== targetFolderId) {
      if (isFolderDescendant(folders, draggedFolderId, targetFolderId)) {
        notify("Cannot move a folder into its own subfolder.");
        return;
      }
      moveFolder(draggedFolderId, { type: "folder", folderId: targetFolderId }).catch((err) => {
        notify(err.message || "Failed to move folder.");
      });
    }
  };

  // Keyboard navigation for accessible tree
  const onKeyDown = (folder, hasChildren, isExpanded, e) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelectFolder(folder.id);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      if (hasChildren && !isExpanded) {
        setExpanded((prev) => ({ ...prev, [folder.id]: true }));
      }
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      if (hasChildren && isExpanded) {
        setExpanded((prev) => ({ ...prev, [folder.id]: false }));
      }
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const items = Array.from(treeRef.current?.querySelectorAll('[role="treeitem"]') ?? []);
      const currentIndex = items.indexOf(document.activeElement);
      if (currentIndex !== -1) {
        const nextIndex =
          e.key === "ArrowDown"
            ? Math.min(items.length - 1, currentIndex + 1)
            : Math.max(0, currentIndex - 1);
        items[nextIndex]?.focus();
      }
    } else if (e.key === "Home") {
      e.preventDefault();
      const items = Array.from(treeRef.current?.querySelectorAll('[role="treeitem"]') ?? []);
      items[0]?.focus();
    } else if (e.key === "End") {
      e.preventDefault();
      const items = Array.from(treeRef.current?.querySelectorAll('[role="treeitem"]') ?? []);
      items[items.length - 1]?.focus();
    }
  };

  const renderNode = (folder, depth = 0) => {
    const hasChildren = folder.children && folder.children.length > 0;
    const isExpanded = Boolean(expanded[folder.id]);
    const isSelected = activeFolderId === folder.id;
    const isDragOver = dragOverId === folder.id;
    const count = countsByFolder[folder.id] ?? 0;
    const isEditing = renamingFolderId === folder.id;
    const busy = isFolderOperationBusy(operations, folder.id);

    return (
      <div key={folder.id} className="flex flex-col">
        <div
          aria-level={depth + 1}
          role="treeitem"
          tabIndex={0}
          aria-expanded={hasChildren ? isExpanded : undefined}
          aria-selected={isSelected}
          onKeyDown={(e) => onKeyDown(folder, hasChildren, isExpanded, e)}
          title={folder.name}
          aria-busy={busy}
          draggable={!isEditing && !busy && !maintenance}
          onDragStart={(e) => {
            if (maintenance) { e.preventDefault(); return; }
            setFolderDragData(e.dataTransfer, folder.id, folder.name);
          }}
          onDragEnd={() => {
            clearFolderDragData();
          }}
          onDragEnter={handleDragEnter(folder.id)}
          onDragOver={handleDragOver(folder.id)}
          onDragLeave={handleDragLeave(folder.id)}
          onDrop={handleDrop(folder.id)}
          onClick={() => onSelectFolder(folder.id)}
          style={{ paddingLeft: `${depth * 0.75 + 0.35}rem` }}
          className={cn(
            "group relative flex min-w-max items-center gap-1 rounded-md py-1 pr-1.5 text-xs transition cursor-pointer select-none outline-none focus-visible:ring-1 focus-visible:ring-brand",
            isSelected
              ? "bg-brand/20 font-medium text-white"
              : "text-white/70 hover:bg-white/5 hover:text-white",
            isDragOver &&
              (dragOverValid
                ? "bg-brand/30 ring-1 ring-brand text-brand"
                : "bg-red-500/25 ring-1 ring-red-500/60 text-red-300 cursor-not-allowed")
          )}
        >
          {/* Chevron expand/collapse */}
          {hasChildren ? (
            <button
              type="button"
              aria-label={`${isExpanded ? "Collapse" : "Expand"} ${folder.name}`}
              tabIndex={-1}
              onClick={(e) => toggleExpand(folder.id, e)}
              className="grid h-4 w-4 shrink-0 place-items-center rounded text-white/40 hover:text-white"
            >
              {isExpanded ? (
                <ChevronDown className="h-3 w-3" />
              ) : (
                <ChevronRight className="h-3 w-3" />
              )}
            </button>
          ) : (
            <span className="w-4 shrink-0" />
          )}

          {/* Folder Icon */}
          {isExpanded ? (
            <FolderOpen
              className={cn(
                "h-3.5 w-3.5 shrink-0 transition",
                isSelected ? "text-brand" : getFolderColorClass(folder.color)
              )}
            />
          ) : (
            <FolderClosed
              className={cn(
                "h-3.5 w-3.5 shrink-0 transition",
                isSelected ? "text-brand" : getFolderColorClass(folder.color)
              )}
            />
          )}

          {/* Folder Name / Inline Rename */}
          {isEditing ? (
            <InlineFolderNameEditor
              initialName={folder.name}
              label="Rename folder"
              onCommit={(name) => renameFolder(folder.projectId, folder.id, name)}
              onClose={() => setRenamingFolderId(null)}
            />
          ) : (
            <span className="flex-1 whitespace-nowrap">{folder.name}</span>
          )}

          {/* Count Badge */}
          {count > 0 && !isEditing && (
            <span
              className={cn(
                "sticky right-6 ml-auto bg-ink-850 px-1 text-[10px] tabular-nums text-white/40 group-hover:text-white/60",
                isSelected && "text-brand/90"
              )}
            >
              {count}
            </span>
          )}

          {busy && <Loader2 aria-label="Folder operation pending" className="h-3 w-3 shrink-0 animate-spin motion-reduce:animate-none" />}
          {/* Folder context menu */}
          <div inert={busy ? true : undefined} onClick={(e) => e.stopPropagation()} className="sticky right-0 shrink-0 bg-ink-850">
            <Dropdown maintenanceWrite
              label={`Tree folder actions: ${folder.name}`}
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

                  {onOpenNewFolderModal && (
                    <MenuItem
                      onClick={() => {
                        close({ restoreFocus: false });
                        onOpenNewFolderModal({ parentId: folder.id, projectId: folder.projectId });
                      }}
                    >
                      <FolderPlus className="h-3.5 w-3.5 text-white/50" />
                      <span>New subfolder</span>
                    </MenuItem>
                  )}
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

        {/* Children */}
        {hasChildren && isExpanded && (
          <div role="group" className="flex flex-col">
            {folder.children.map((child) => renderNode(child, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="min-w-0 max-w-full">
      <div className="flex justify-end gap-1 text-[10px] text-white/50">
        <button type="button" aria-label="Scroll folder names left" onClick={() => treeRef.current?.parentElement.scrollBy({ left: -160 })} className="rounded px-2 hover:bg-white/10">←</button>
        <button type="button" aria-label="Scroll folder names right" onClick={() => treeRef.current?.parentElement.scrollBy({ left: 160 })} className="rounded px-2 hover:bg-white/10">→</button>
      </div>
      <div data-testid="folder-hierarchy-viewport" tabIndex={0} aria-label="Scroll full folder names" className="scroll-thin max-w-full overflow-x-auto overscroll-x-contain" onKeyDown={(e) => {
        if (e.target === e.currentTarget && ["ArrowLeft", "ArrowRight"].includes(e.key)) { e.preventDefault(); e.currentTarget.scrollBy({ left: e.key === "ArrowLeft" ? -160 : 160 }); }
      }}>
    <div
      ref={treeRef}
      id={treeId}
      role="tree"
      aria-label="Folder Hierarchy"
      className="flex min-w-full w-max flex-col gap-0.5"
    >
      {folders.map((rootFolder) => renderNode(rootFolder, 0))}
    </div></div></div>
  );
}

// [in progress, done, failed] wording for each tracked folder operation.
const OPERATION_LABELS = {
  createFolder: ["Creating folder", "Created folder", "Couldn't create folder"],
  renameFolder: ["Renaming folder", "Renamed folder", "Couldn't rename folder"],
  setFolderColor: ["Changing folder color", "Changed folder color", "Couldn't change folder color"],
  deleteFolder: ["Deleting folder", "Deleted folder", "Couldn't delete folder"],
  moveFolder: ["Moving folder", "Moved folder", "Couldn't move folder"],
  renameFolderGenerations: ["Renaming generations to match folder", "Renamed generations to match folder", "Couldn't rename generations"],
  moveGenerationsToDestination: ["Moving assets", "Moved assets", "Couldn't move assets"],
};
/** How long a finished operation stays in the rail before it clears itself. */
export const SETTLED_OPERATION_MS = 6000;
const MAX_VISIBLE_OPERATIONS = 3;

export function folderOperationLabel(op) {
  const [doing, done, failed] = OPERATION_LABELS[op.operation] ?? ["Updating folders", "Updated folders", "Couldn't update folders"];
  const moving = op.operation === "moveGenerationsToDestination";
  switch (op.status) {
    case "queued": return `${moving ? `Moving ${op.total} assets` : doing} (waiting)`;
    case "pending": return `${moving ? `Moving ${op.total} assets` : doing}…`;
    case "confirmed": return moving ? `Moved ${op.committedCount ?? 0} of ${op.total} assets` : done;
    case "cancelled": return `Cancelled: ${doing.toLowerCase()}`;
    case "conflicted": return `${failed}: it changed elsewhere${op.error ? ` (${op.error})` : ""}`;
    default: return `${failed}${op.error ? `: ${op.error}` : ""}`;
  }
}

/** Operations still running or needing a decision stay until handled (newest
 *  first, a few at a time); a finished one shows briefly, then clears itself. */
export function FolderOperationRail() {
  const operations = useStore((s) => s.operations);
  const loadLibraryTree = useStore((s) => s.loadLibraryTree);
  const cancelOperation = useStore((s) => s.cancelFolderOperation);
  const [retryError, setRetryError] = useState("");
  const [dismissed, setDismissed] = useState(() => new Set());
  const [now, setNow] = useState(() => Date.now());
  const entries = Object.entries(operations || {}).filter(([, op]) => !dismissed.has(`${op.key}:${op.attempt}`)).reverse();
  const settledAt = (op) => op.completedAt ?? op.startedAt ?? 0;
  const isSettled = (op) => ["confirmed", "cancelled"].includes(op.status);
  const fresh = entries.filter(([, op]) => !isSettled(op) || now - settledAt(op) < SETTLED_OPERATION_MS);
  const visible = fresh.slice(0, MAX_VISIBLE_OPERATIONS);
  const hidden = fresh.length - visible.length;
  const nextExpiry = Math.min(...fresh.filter(([, op]) => isSettled(op)).map(([, op]) => settledAt(op) + SETTLED_OPERATION_MS));
  useEffect(() => {
    if (!Number.isFinite(nextExpiry)) return undefined;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, nextExpiry - Date.now()) + 50);
    return () => clearTimeout(timer);
  }, [nextExpiry, operations]);
  const retry = async (logical) => {
    try {
      const [actor, action, args] = JSON.parse(logical);
      const state = useStore.getState();
      if (actor !== (state.currentUser?.id || "anonymous") || typeof state[action] !== "function") return;
      setRetryError("");
      await state[action](...args);
    } catch (error) { setRetryError(error.message || "Retry failed."); }
  };
  if (!visible.length && !retryError) return null;
  return <div role="status" aria-live="polite" className="shrink-0 border-t border-line px-2 py-1 text-[10px] text-white/60">
    {visible.map(([logical, op]) => <div key={op.key} className="flex flex-wrap items-start gap-x-1 py-0.5">
      {["queued", "pending"].includes(op.status) && <Loader2 className="mt-0.5 h-3 w-3 shrink-0 animate-spin motion-reduce:animate-none" />}
      <span className="min-w-0 flex-1 break-words">{folderOperationLabel(op)}{op.attempt > 1 ? ` (attempt ${op.attempt})` : ""}</span>
      {op.status === "queued" && <button type="button" className="underline" onClick={() => cancelOperation(logical)}>Cancel</button>}
      {["failed", "conflicted"].includes(op.status) && <span className="flex basis-full flex-wrap gap-x-2"><button type="button" className="underline" onClick={() => void retry(logical)}>Retry</button><button type="button" className="underline" onClick={() => loadLibraryTree().catch(() => {})}>Refresh folders</button><button type="button" className="underline" aria-label={`Dismiss: ${folderOperationLabel(op)}`} onClick={() => setDismissed((keys) => new Set(keys).add(`${op.key}:${op.attempt}`))}>Dismiss</button></span>}
    </div>)}
    {hidden > 0 && <p className="py-0.5 text-white/40">+{hidden} more</p>}
    {retryError && <p role="alert" className="text-red-400">{retryError}</p>}
  </div>;
}

export function isFolderOperationBusy(operations, folderId) {
  return Object.entries(operations || {}).some(([logical, op]) => {
    if (!["pending", "queued"].includes(op.status)) return false;
    try {
      const entity = JSON.parse(op.entity || "[]");
      if (entity[1] === folderId) return true;
      const [, action, args] = JSON.parse(logical);
      return ["renameFolder", "deleteFolder"].includes(action) && (args[0] === folderId || args[1] === folderId);
    } catch { return false; }
  });
}
