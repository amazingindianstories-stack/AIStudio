"use client";

import { useEffect, useState } from "react";
import {
  ChevronRight,
  FolderClosed,
  Layers,
  Inbox,
  MoreHorizontal,
  FolderPlus,
  Pencil,
  Move,
  Trash2,
} from "lucide-react";
import { useStore } from "@/lib/store";
import { apiFetch } from "@/lib/api";
import { UNSORTED } from "@/lib/feed-scope";
import { Dropdown, MenuItem } from "./Dropdown";

export function BreadcrumbBar({ onOpenMoveModal, onOpenNewFolderModal }) {
  const activeProjectId = useStore((s) => s.activeProjectId);
  const activeFolderId = useStore((s) => s.activeFolderId);
  const projects = useStore((s) => s.projects);
  const setActiveFolder = useStore((s) => s.setActiveFolder);
  const renameFolder = useStore((s) => s.renameFolder);
  const deleteFolder = useStore((s) => s.deleteFolder);

  const [ancestry, setAncestry] = useState([]);
  const [, setLoadingAncestry] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [renameError, setRenameError] = useState(null);

  const currentProject = projects.find((p) => p.id === activeProjectId) ?? null;

  // Fetch authoritative ancestry trail from server whenever activeFolderId changes
  useEffect(() => {
    setIsRenaming(false);
    setRenameError(null);
    if (!activeFolderId || activeFolderId === UNSORTED) {
      setAncestry([]);
      return;
    }

    let cancelled = false;
    setLoadingAncestry(true);

    apiFetch(`/api/folders?ancestry=${encodeURIComponent(activeFolderId)}`)
      .then((res) => (res.ok ? res.json() : { breadcrumbs: [] }))
      .then((data) => {
        if (!cancelled) {
          setAncestry(data.breadcrumbs || []);
          setLoadingAncestry(false);
        }
      })
      .catch(() => {
        if (!cancelled) setLoadingAncestry(false);
      });

    return () => {
      cancelled = true;
    };
  }, [activeFolderId]);

  const currentFolder = ancestry.length > 0 ? ancestry[ancestry.length - 1] : null;

  const handleRename = () => {
    if (!currentFolder) return;
    setIsRenaming(true);
    setRenameValue(currentFolder.name);
    setRenameError(null);
  };

  const handleDelete = () => {
    if (!currentFolder) return;
    if (
      window.confirm(
        `Delete folder "${currentFolder.name}"? Only empty folders can be deleted.`
      )
    ) {
      deleteFolder(currentFolder.projectId, currentFolder.id).catch((err) => {
        alert(err.message || "Failed to delete folder.");
      });
    }
  };

  return (
    <div className="flex items-center justify-between border-b border-line bg-ink-850 px-4 py-2 text-xs">
      {/* Breadcrumb list */}
      <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 overflow-x-auto scroll-thin py-0.5">
        {/* Root crumb */}
        {currentProject ? (
          <button
            type="button"
            onClick={() => setActiveFolder(null)}
            className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-white/60 transition hover:bg-white/10 hover:text-white"
          >
            <Layers className="h-3.5 w-3.5 text-brand/80" />
            <span className="font-medium truncate max-w-[140px]">{currentProject.name}</span>
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setActiveFolder(null)}
            className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-white/60 transition hover:bg-white/10 hover:text-white"
          >
            <Layers className="h-3.5 w-3.5 text-white/50" />
            <span className="font-medium">Global Library</span>
          </button>
        )}

        {/* Unsorted Crumb */}
        {activeFolderId === UNSORTED && (
          <>
            <ChevronRight className="h-3 w-3 shrink-0 text-white/30" />
            <div className="flex shrink-0 items-center gap-1 rounded-md bg-white/5 px-2 py-1 font-semibold text-white">
              <Inbox className="h-3.5 w-3.5 text-white/50" />
              <span>Unsorted</span>
            </div>
          </>
        )}

        {/* Hierarchical ancestry trail */}
        {ancestry.map((crumb, idx) => {
          const isLast = idx === ancestry.length - 1;
          return (
            <div key={crumb.id} className="flex shrink-0 items-center gap-1.5">
              <ChevronRight className="h-3 w-3 text-white/30" />
              {isLast ? (
                isRenaming ? (
                  <form
                    onSubmit={async (e) => {
                      e.preventDefault();
                      const trimmed = renameValue.trim();
                      if (!trimmed || trimmed === crumb.name) {
                        setIsRenaming(false);
                        return;
                      }
                      try {
                        await renameFolder(crumb.projectId, crumb.id, trimmed);
                        setIsRenaming(false);
                        setAncestry((prev) =>
                          prev.map((c) => (c.id === crumb.id ? { ...c, name: trimmed } : c))
                        );
                      } catch (err) {
                        setRenameError(err.message || "Failed to rename folder");
                      }
                    }}
                    className="flex items-center gap-1"
                  >
                    <FolderClosed className="h-3.5 w-3.5 text-amber-400/90 shrink-0" />
                    <input
                      type="text"
                      value={renameValue}
                      autoFocus
                      onChange={(e) => {
                        setRenameValue(e.target.value);
                        setRenameError(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") {
                          setIsRenaming(false);
                          setRenameError(null);
                        }
                      }}
                      onBlur={async () => {
                        const trimmed = renameValue.trim();
                        if (!trimmed || trimmed === crumb.name) {
                          setIsRenaming(false);
                          return;
                        }
                        try {
                          await renameFolder(crumb.projectId, crumb.id, trimmed);
                          setIsRenaming(false);
                          setAncestry((prev) =>
                            prev.map((c) => (c.id === crumb.id ? { ...c, name: trimmed } : c))
                          );
                        } catch (err) {
                          setRenameError(err.message || "Failed to rename folder");
                        }
                      }}
                      className="rounded border border-brand/60 bg-ink-900 px-1 py-0.5 text-xs text-white outline-none focus:border-brand"
                    />
                    {renameError && (
                      <span className="text-[10px] text-red-400 ml-1">{renameError}</span>
                    )}
                  </form>
                ) : (
                  <div className="flex items-center gap-1 rounded-md bg-white/5 px-2 py-1 font-semibold text-white">
                    <FolderClosed className="h-3.5 w-3.5 text-amber-400/90" />
                    <span className="truncate max-w-[160px]">{crumb.name}</span>
                  </div>
                )
              ) : (
                <button
                  type="button"
                  onClick={() => setActiveFolder(crumb.id)}
                  className="flex items-center gap-1 rounded-md px-1.5 py-1 text-white/60 transition hover:bg-white/10 hover:text-white"
                >
                  <FolderClosed className="h-3.5 w-3.5 text-white/40" />
                  <span className="truncate max-w-[140px]">{crumb.name}</span>
                </button>
              )}
            </div>
          );
        })}
      </nav>

      {/* Folder Context Toolbar / Actions */}
      <div className="flex shrink-0 items-center gap-1 pl-2">
        {onOpenNewFolderModal && (
          <button
            type="button"
            onClick={onOpenNewFolderModal}
            className="flex items-center gap-1 rounded-md bg-white/5 px-2 py-1 text-xs text-white/70 transition hover:bg-white/10 hover:text-white"
            title={activeFolderId && activeFolderId !== UNSORTED ? "New subfolder" : "New folder"}
          >
            <FolderPlus className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">
              {activeFolderId && activeFolderId !== UNSORTED ? "New subfolder" : "New folder"}
            </span>
          </button>
        )}

        {currentFolder && (
          <Dropdown
            align="right"
            trigger={(_open) => (
              <span
                className="grid h-6 w-6 place-items-center rounded-md text-white/50 transition hover:bg-white/10 hover:text-white"
                title="Folder actions"
              >
                <MoreHorizontal className="h-4 w-4" />
              </span>
            )}
          >
            {(close) => (
              <div className="py-1">
                <MenuItem
                  onClick={() => {
                    close();
                    handleRename();
                  }}
                >
                  <Pencil className="h-3.5 w-3.5 text-white/50" />
                  <span>Rename</span>
                </MenuItem>
                {onOpenMoveModal && (
                  <MenuItem
                    onClick={() => {
                      close();
                      onOpenMoveModal(currentFolder);
                    }}
                  >
                    <Move className="h-3.5 w-3.5 text-white/50" />
                    <span>Move folder</span>
                  </MenuItem>
                )}
                <div className="my-1 h-px bg-line" />
                <MenuItem
                  onClick={() => {
                    close();
                    handleDelete();
                  }}
                  className="text-red-400 hover:text-red-300"
                >
                  <Trash2 className="h-3.5 w-3.5 text-red-400" />
                  <span>Delete folder</span>
                </MenuItem>
              </div>
            )}
          </Dropdown>
        )}
      </div>
    </div>
  );
}
