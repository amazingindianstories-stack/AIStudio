"use client";

import { useMemo, useState } from "react";
import {
  FolderClosed,
  FolderPlus,
  MoreVertical,
  Pencil,
  Move,
  Trash2,
} from "lucide-react";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { Dropdown, MenuItem } from "./Dropdown";

export function ChildFolderList({
  parentId = null,
  projectId = null,
  onOpenMoveModal,
  onOpenNewFolderModal,
}) {
  const libraryTree = useStore((s) => s.libraryTree);
  const counts = useStore((s) => s.counts);
  const setActiveFolder = useStore((s) => s.setActiveFolder);
  const renameFolder = useStore((s) => s.renameFolder);
  const deleteFolder = useStore((s) => s.deleteFolder);
  const moveItem = useStore((s) => s.moveItem);
  const moveFolder = useStore((s) => s.moveFolder);

  const [dragOverFolderId, setDragOverFolderId] = useState(null);

  // Find immediate child folders from libraryTree
  const childFolders = useMemo(() => {
    if (!libraryTree) return [];

    // Helper to find a folder by ID anywhere in a tree
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
      // Find the folder and return its children
      const allRoots = [
        ...(libraryTree.globalFolders ?? []),
        ...(libraryTree.projects?.flatMap((p) => p.folders ?? []) ?? []),
      ];
      const node = findNode(allRoots, parentId);
      return node?.children ?? [];
    }

    // Root level:
    if (projectId) {
      const proj = libraryTree.projects?.find((p) => p.id === projectId);
      return (proj?.folders ?? []).filter((f) => !f.parentId);
    }

    // Global Root level:
    return (libraryTree.globalFolders ?? []).filter((f) => !f.parentId);
  }, [libraryTree, parentId, projectId]);

  if (!childFolders.length) return null;

  const handleDropOnFolder = (targetFolderId) => (e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOverFolderId(null);

    const itemId = e.dataTransfer.getData("text/itemId");
    const draggedFolderId = e.dataTransfer.getData("text/folderId");

    if (itemId) {
      moveItem(itemId, { type: "folder", folderId: targetFolderId }).catch((err) => {
        alert(err.message || "Failed to move item.");
      });
    } else if (draggedFolderId && draggedFolderId !== targetFolderId) {
      moveFolder(draggedFolderId, { type: "folder", folderId: targetFolderId }).catch((err) => {
        alert(err.message || "Failed to move folder.");
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
    <div className="border-b border-line bg-ink-850/60 p-4">
      <div className="mb-2.5 flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-white/40">
          Folders ({childFolders.length})
        </span>
        {onOpenNewFolderModal && (
          <button
            type="button"
            onClick={onOpenNewFolderModal}
            className="flex items-center gap-1 rounded-md px-2 py-0.5 text-xs text-white/50 hover:bg-white/10 hover:text-white transition"
          >
            <FolderPlus className="h-3 w-3" />
            <span>New</span>
          </button>
        )}
      </div>

      {/* Grid of child folder cards */}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(130px,1fr))] gap-2.5">
        {childFolders.map((folder) => {
          const count = getFolderCount(folder.id);
          const isDragOver = dragOverFolderId === folder.id;

          return (
            <div
              key={folder.id}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData("text/folderId", folder.id);
                e.dataTransfer.effectAllowed = "move";
              }}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOverFolderId(folder.id);
              }}
              onDragLeave={() => setDragOverFolderId(null)}
              onDrop={handleDropOnFolder(folder.id)}
              onClick={() => setActiveFolder(folder.id)}
              className={cn(
                "group relative flex flex-col justify-between rounded-xl border border-line bg-ink-800/80 p-3 transition hover:border-white/20 hover:bg-ink-750 cursor-pointer select-none",
                isDragOver && "border-brand bg-brand/10 ring-1 ring-brand"
              )}
            >
              <div className="flex items-start justify-between gap-1">
                <FolderClosed className="h-5 w-5 text-amber-400/90 group-hover:text-amber-300 transition shrink-0" />
                <div onClick={(e) => e.stopPropagation()}>
                  <Dropdown
                    align="right"
                    trigger={(open) => (
                      <span
                        className={cn(
                          "grid h-6 w-6 place-items-center rounded-md text-white/40 opacity-0 group-hover:opacity-100 transition hover:bg-white/10 hover:text-white",
                          open && "opacity-100 bg-white/10 text-white"
                        )}
                      >
                        <MoreVertical className="h-3.5 w-3.5" />
                      </span>
                    )}
                  >
                    {(close) => (
                      <div className="py-1">
                        <MenuItem
                          onClick={() => {
                            close();
                            const name = window.prompt("Rename folder", folder.name);
                            if (name?.trim()) renameFolder(folder.projectId, folder.id, name.trim());
                          }}
                        >
                          <Pencil className="h-3.5 w-3.5 text-white/50" />
                          <span>Rename</span>
                        </MenuItem>
                        {onOpenMoveModal && (
                          <MenuItem
                            onClick={() => {
                              close();
                              onOpenMoveModal(folder);
                            }}
                          >
                            <Move className="h-3.5 w-3.5 text-white/50" />
                            <span>Move...</span>
                          </MenuItem>
                        )}
                        <div className="my-1 h-px bg-line" />
                        <MenuItem
                          onClick={() => {
                            close();
                            if (window.confirm(`Delete folder "${folder.name}"? Only empty folders can be deleted.`)) {
                              deleteFolder(folder.projectId, folder.id).catch((err) => {
                                alert(err.message || "Failed to delete folder.");
                              });
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
                </div>
              </div>

              <div className="mt-2 min-w-0">
                <p className="truncate text-xs font-semibold text-white/90 group-hover:text-white">
                  {folder.name}
                </p>
                <p className="mt-0.5 text-[11px] text-white/40">
                  {count} {count === 1 ? "asset" : "assets"}
                  {folder.children?.length > 0 && ` · ${folder.children.length} sub`}
                </p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
