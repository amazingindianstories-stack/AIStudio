"use client";
import { useMaintenance } from "@/lib/maintenance-client";

import { useEffect, useRef, useState } from "react";
import { notify } from "@/lib/notify";
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
import { RenameFolderGenerationsItem } from "./RenameFolderGenerationsItem";
import { InlineFolderNameEditor } from "./InlineFolderNameEditor";
import { getFolderColorClass, FOLDER_COLOR_OPTIONS } from "@/lib/folder-colors";
import { cn } from "@/lib/utils";
import { askConfirm } from "@/lib/ask-text";

/** The narrowest the full trail can be, in px: each crumb's minimum width
 *  (chevron included) plus the 4px gaps. The workspace takes 50, a folded
 *  menu 40, a parent 66 (38 beside the menu), the current folder 74. Below
 *  it, every ancestor folds and the workspace keeps only its icon. */
function minimumTrailWidth(depth) {
  if (depth === 0) return 0;
  if (depth === 1) return 50 + 4 + 74;
  if (depth === 2) return 50 + 4 + 66 + 4 + 74;
  return 50 + 4 + 40 + 4 + 38 + 4 + 74;
}

export function BreadcrumbBar({ onOpenMoveModal, onOpenNewFolderModal }) {
  const maintenance = useMaintenance((s) => s.enabled);
  const isAdmin = useStore((s) => s.currentUser?.role === "admin");
  const activeProjectId = useStore((s) => s.activeProjectId);
  const activeFolderId = useStore((s) => s.activeFolderId);
  const libraryTree = useStore((s) => s.libraryTree);
  const projects = useStore((s) => s.projects);
  const setActiveFolder = useStore((s) => s.setActiveFolder);
  const renameFolder = useStore((s) => s.renameFolder);
  const deleteFolder = useStore((s) => s.deleteFolder);
  const setFolderColor = useStore((s) => s.setFolderColor);

  const [ancestry, setAncestry] = useState([]);
  const [, setLoadingAncestry] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);

  const currentProject = projects.find((p) => p.id === activeProjectId) ?? null;

  // Fetch authoritative ancestry trail from server whenever activeFolderId changes
  useEffect(() => {

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
  }, [activeFolderId, libraryTree]);

  useEffect(() => setIsRenaming(false), [activeFolderId, activeProjectId]);

  // The trail's width comes from the layout (it is a flex-1 item), not from its
  // crumbs, so measuring it cannot feed back into itself.
  const navRef = useRef(null);
  const [navWidth, setNavWidth] = useState(0);
  useEffect(() => {
    const nav = navRef.current;
    if (!nav || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(([entry]) => setNavWidth(entry.contentRect.width));
    observer.observe(nav);
    return () => observer.disconnect();
  }, []);

  const narrow = navWidth > 0 && navWidth < minimumTrailWidth(ancestry.length);
  const currentFolder = ancestry.length > 0 ? ancestry[ancestry.length - 1] : null;
  const rootName = currentProject ? currentProject.name : "Global Library";
  // The trail keeps its two ends: the workspace, the parent and the current
  // folder stay on screen, and any ancestors between them fold into one menu.
  // Too narrow for that, every ancestor folds and the workspace keeps its icon.
  const collapsed = narrow ? ancestry.slice(0, -1) : ancestry.length > 2 ? ancestry.slice(0, -2) : [];
  const shown = ancestry.slice(collapsed.length);
  const pathTo = (index) => [rootName, ...ancestry.slice(0, index + 1).map((crumb) => crumb.name)].join(" / ");
  const fullPath = activeFolderId === UNSORTED ? `${rootName} / Unsorted` : pathTo(ancestry.length - 1);

  const handleRename = () => {
    if (!currentFolder) return;
    setIsRenaming(true);


  };

  const handleDelete = async () => {
    if (!currentFolder) return;
    if (
      await askConfirm({ title: `Delete folder "${currentFolder.name}"?`, description: "Only empty folders can be deleted.", confirmLabel: "Delete", destructive: true })
    ) {
      deleteFolder(currentFolder.projectId, currentFolder.id).catch((err) => {
        notify(err.message || "Failed to delete folder.");
      });
    }
  };

  return (
    <div className="flex min-w-0 flex-1 items-center text-xs">
      {/* Breadcrumb list */}
      <nav ref={navRef} aria-label="Breadcrumb" title={fullPath}
        className="flex flex-1 min-w-0 items-center gap-1 overflow-hidden py-0.5">
        {/* Root crumb. Names shrink to an ellipsis (each tooltip gives the path
            to it): the parent first, then the workspace, then the current folder;
            at its minimum width each keeps its icon and 1.5rem of name (a parent
            beside folded ancestors keeps only its icon). The
            trail starts at its left edge and never scrolls it away. */}
        <button
          type="button"
          onClick={() => setActiveFolder(null)}
          title={rootName}
          aria-label={narrow ? rootName : undefined}
          className={cn("flex items-center gap-1 rounded-md px-1 py-1 text-white/60 transition hover:bg-white/10 hover:text-white", narrow ? "shrink-0" : "min-w-[3.125rem] shrink-[1000000]")}
        >
          <Layers className={cn("h-3.5 w-3.5 shrink-0", currentProject ? "text-brand/80" : "text-white/50")} />
          {!narrow && <span className="font-medium truncate max-w-[140px]">{rootName}</span>}
        </button>

        {collapsed.length > 0 && (
          <div className="flex shrink-0 items-center gap-1">
            <ChevronRight className="h-3 w-3 shrink-0 text-white/30" />
            <Dropdown
              align="left"
              label={`Show ${collapsed.length} hidden ${collapsed.length === 1 ? "folder" : "folders"}`}
              trigger={() => (
                <span title={pathTo(collapsed.length - 1)} className="grid h-6 w-6 place-items-center rounded-md text-white/60 transition hover:bg-white/10 hover:text-white">
                  <MoreHorizontal className="h-3.5 w-3.5" />
                </span>
              )}
            >
              {(close) => (
                <div className="py-1 min-w-[160px] max-w-[280px]">
                  {collapsed.map((crumb, idx) => (
                    <MenuItem key={crumb.id} onClick={() => { close(); setActiveFolder(crumb.id); }}>
                      <span title={pathTo(idx)} className="flex min-w-0 items-center gap-2" style={{ paddingLeft: `${idx * 0.5}rem` }}>
                        <FolderClosed className={cn("h-3.5 w-3.5 shrink-0", getFolderColorClass(crumb.color))} />
                        <span className="truncate">{crumb.name}</span>
                      </span>
                    </MenuItem>
                  ))}
                </div>
              )}
            </Dropdown>
          </div>
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
        {shown.map((crumb, shownIdx) => {
          const idx = collapsed.length + shownIdx;
          const isLast = idx === ancestry.length - 1;
          return (
            <div key={crumb.id} className={cn("flex items-center gap-1", !isLast ? (collapsed.length ? "min-w-[2.375rem] shrink-[100000000]" : "min-w-[4.125rem] shrink-[100000000]") : isRenaming ? "shrink-0" : narrow ? "min-w-[3.25rem]" : "min-w-[4.625rem]")}>
              <ChevronRight className="h-3 w-3 shrink-0 text-white/30" />
              {isLast ? (
                isRenaming ? (
                  <InlineFolderNameEditor
                    initialName={crumb.name}
                    label="Rename folder"
                    onCommit={(name) => renameFolder(crumb.projectId, crumb.id, name)}
                    onClose={() => setIsRenaming(false)}
                  />
                ) : (
                  <div title={pathTo(idx)} aria-current="page" className="flex min-w-0 items-center gap-1 rounded-md bg-white/5 px-2 py-1 font-semibold text-white">
                    <FolderClosed className={cn("h-3.5 w-3.5 shrink-0", getFolderColorClass(crumb.color))} />
                    <span className="truncate max-w-[160px]">{crumb.name}</span>
                  </div>
                )
              ) : (
                <button
                  type="button"
                  onClick={() => setActiveFolder(crumb.id)}
                  title={pathTo(idx)}
                  className="flex min-w-0 items-center gap-1 rounded-md px-1 py-1 text-white/60 transition hover:bg-white/10 hover:text-white"
                >
                  <FolderClosed className={cn("h-3.5 w-3.5 shrink-0", getFolderColorClass(crumb.color))} />
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
            disabled={maintenance}
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
            maintenanceWrite
            label="Current folder actions"
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
                          setFolderColor(currentFolder.id, opt.id === "default" ? null : opt.id);
                        }}
                        className={cn(
                          "grid h-4 w-4 place-items-center rounded-full transition hover:scale-125",
                          (currentFolder.color || "default") === opt.id &&
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
                    handleRename();
                  }}
                >
                  <Pencil className="h-3.5 w-3.5 text-white/50" />
                  <span>Rename</span>
                </MenuItem>
                {onOpenMoveModal && (
                  <MenuItem
                    onClick={() => {
                      close({ restoreFocus: false });
                      onOpenMoveModal(currentFolder);
                    }}
                  >
                    <Move className="h-3.5 w-3.5 text-white/50" />
                    <span>Move folder</span>
                  </MenuItem>
                )}
                <RenameFolderGenerationsItem folder={currentFolder} close={close} />
                  {isAdmin && <div className="my-1 h-px bg-line" />}
                {isAdmin && (<MenuItem
                  onClick={() => {
                    close();
                    handleDelete();
                  }}
                  className="text-red-400 hover:text-red-300"
                >
                  <Trash2 className="h-3.5 w-3.5 text-red-400" />
                  <span>Delete folder</span>
                </MenuItem>)}
              </div>
            )}
          </Dropdown>
        )}
      </div>
    </div>
  );
}
