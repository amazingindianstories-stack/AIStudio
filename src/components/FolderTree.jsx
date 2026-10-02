"use client";

import { useId, useRef, useState } from "react";
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
} from "lucide-react";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { Dropdown, MenuItem } from "./Dropdown";

export function FolderTree({
  folders = [],
  activeFolderId = null,
  countsByFolder = {},
  projectId = null,
  onSelectFolder,
  onOpenMoveModal,
  onOpenNewFolderModal,
}) {
  const [expanded, setExpanded] = useState({});
  const [dragOverId, setDragOverId] = useState(null);
  const renameFolder = useStore((s) => s.renameFolder);
  const deleteFolder = useStore((s) => s.deleteFolder);
  const moveItem = useStore((s) => s.moveItem);
  const moveFolder = useStore((s) => s.moveFolder);

  const treeId = useId();
  const treeRef = useRef(null);

  const toggleExpand = (id, e) => {
    e?.stopPropagation();
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const handleDrop = (targetFolderId) => (e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOverId(null);

    const itemId = e.dataTransfer.getData("text/itemId");
    const draggedFolderId = e.dataTransfer.getData("text/folderId");

    if (itemId) {
      moveItem(itemId, { type: "folder", folderId: targetFolderId, projectId }).catch((err) => {
        alert(err.message || "Failed to move item.");
      });
    } else if (draggedFolderId && draggedFolderId !== targetFolderId) {
      moveFolder(draggedFolderId, { type: "folder", folderId: targetFolderId }).catch((err) => {
        alert(err.message || "Failed to move folder.");
      });
    }
  };

  const handleDragOver = (id) => (e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOverId(id);
  };

  const handleDragLeave = (id) => (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (dragOverId === id) setDragOverId(null);
  };

  // Keyboard navigation for accessible tree
  const onKeyDown = (folder, hasChildren, isExpanded, e) => {
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
    }
  };

  const renderNode = (folder, depth = 0) => {
    const hasChildren = folder.children && folder.children.length > 0;
    const isExpanded = Boolean(expanded[folder.id]);
    const isSelected = activeFolderId === folder.id;
    const isDragOver = dragOverId === folder.id;
    const count = countsByFolder[folder.id] ?? 0;

    return (
      <div key={folder.id} className="flex flex-col">
        <div
          role="treeitem"
          tabIndex={0}
          aria-expanded={hasChildren ? isExpanded : undefined}
          aria-selected={isSelected}
          onKeyDown={(e) => onKeyDown(folder, hasChildren, isExpanded, e)}
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData("text/folderId", folder.id);
            e.dataTransfer.effectAllowed = "move";
          }}
          onDragOver={handleDragOver(folder.id)}
          onDragLeave={handleDragLeave(folder.id)}
          onDrop={handleDrop(folder.id)}
          onClick={() => onSelectFolder(folder.id)}
          style={{ paddingLeft: `${depth * 0.75 + 0.35}rem` }}
          className={cn(
            "group relative flex items-center gap-1 rounded-md py-1 pr-1.5 text-xs transition cursor-pointer select-none outline-none focus-visible:ring-1 focus-visible:ring-brand",
            isSelected
              ? "bg-brand/20 font-medium text-white"
              : "text-white/70 hover:bg-white/5 hover:text-white",
            isDragOver && "bg-brand/30 ring-1 ring-brand"
          )}
        >
          {/* Chevron expand/collapse */}
          {hasChildren ? (
            <button
              type="button"
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
                "h-3.5 w-3.5 shrink-0",
                isSelected ? "text-brand" : "text-amber-400/80"
              )}
            />
          ) : (
            <FolderClosed
              className={cn(
                "h-3.5 w-3.5 shrink-0",
                isSelected ? "text-brand" : "text-amber-400/80"
              )}
            />
          )}

          {/* Folder Name */}
          <span className="min-w-0 flex-1 truncate">{folder.name}</span>

          {/* Count Badge */}
          {count > 0 && (
            <span
              className={cn(
                "ml-auto text-[10px] tabular-nums text-white/40 group-hover:text-white/60",
                isSelected && "text-brand/90"
              )}
            >
              {count}
            </span>
          )}

          {/* Folder context menu */}
          <div onClick={(e) => e.stopPropagation()} className="shrink-0">
            <Dropdown
              align="right"
              trigger={(open) => (
                <span
                  className={cn(
                    "grid h-5 w-5 place-items-center rounded text-white/40 opacity-0 group-hover:opacity-100 transition hover:bg-white/10 hover:text-white",
                    open && "opacity-100 bg-white/10 text-white"
                  )}
                >
                  <MoreVertical className="h-3 w-3" />
                </span>
              )}
            >
              {(close) => (
                <div className="py-1">
                  {onOpenNewFolderModal && (
                    <MenuItem
                      onClick={() => {
                        close();
                        onOpenNewFolderModal({ parentId: folder.id, projectId: folder.projectId });
                      }}
                    >
                      <FolderPlus className="h-3.5 w-3.5 text-white/50" />
                      <span>New subfolder</span>
                    </MenuItem>
                  )}
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
                      if (
                        window.confirm(
                          `Delete folder "${folder.name}"? Only empty folders can be deleted.`
                        )
                      ) {
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

        {/* Children */}
        {hasChildren && isExpanded && (
          <div className="flex flex-col">
            {folder.children.map((child) => renderNode(child, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div
      ref={treeRef}
      id={treeId}
      role="tree"
      aria-label="Folder Hierarchy"
      className="flex flex-col gap-0.5"
    >
      {folders.map((rootFolder) => renderNode(rootFolder, 0))}
    </div>
  );
}
