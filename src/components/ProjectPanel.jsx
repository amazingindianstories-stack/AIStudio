"use client";

import { useEffect, useRef, useState, useMemo } from "react";
import { notify } from "@/lib/notify";
import {
  FolderClosed,
  FolderPlus,
  Layers,
  FileText,
  Inbox,
  Pencil,
  Trash2,
  Search as SearchIcon,
  Loader2,
} from "lucide-react";
import { useStore } from "@/lib/store";
import { apiFetch } from "@/lib/api";
import { MediaCard } from "./MediaCard";
import { AssetGrid } from "./AssetGrid";
import { UNSORTED } from "@/lib/feed-scope";
import { cn } from "@/lib/utils";
import { FolderTree, FolderOperationRail } from "./FolderTree";
import { BreadcrumbBar } from "./BreadcrumbBar";
import { ChildFolderList } from "./ChildFolderList";
import { DestinationPickerModal } from "./DestinationPickerModal";
import { InlineFolderNameEditor } from "./InlineFolderNameEditor";
import {
  getAssetDragData,
  getFolderDragData,
  isFolderDragEvent,
} from "@/lib/asset-drag-contract";
import { askConfirm, askText } from "@/lib/ask-text";

export function ProjectPanel({ cardWidth = 160 }) {
  const projects = useStore((s) => s.projects);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const activeFolderId = useStore((s) => s.activeFolderId);
  const libraryTree = useStore((s) => s.libraryTree);
  const items = useStore((s) => s.items);
  const isAdmin = useStore((s) => s.currentUser?.role === "admin");
  const loading = useStore((s) => s.loading);
  const counts = useStore((s) => s.counts);
  const search = useStore((s) => s.search);
  const filterKind = useStore((s) => s.filterKind);
  const setActiveProject = useStore((s) => s.setActiveProject);
  const setActiveFolder = useStore((s) => s.setActiveFolder);
  const renameProject = useStore((s) => s.renameProject);
  const deleteProject = useStore((s) => s.deleteProject);
  const createFolder = useStore((s) => s.createFolder);
  const moveFolder = useStore((s) => s.moveFolder);
  const moveGenerationsToDestination = useStore((s) => s.moveGenerationsToDestination);

  const [briefView, setBriefView] = useState(false);
  const [addingScope, setAddingScope] = useState(null); // { projectId, parentId } or null
  const [dragOverRoot, setDragOverRoot] = useState(null);
  const [dragOverValid, setDragOverValid] = useState(true);
  const rootCounterMap = useRef(new Map());

  // Move Modal State
  const [moveModalOpen, setMoveModalOpen] = useState(false);
  const [movingFolder, setMovingFolder] = useState(null);

  const project = projects.find((p) => p.id === activeProjectId) ?? null;

  // Switching project must close brief editor if opened
  useEffect(() => {
    setBriefView(false);
  }, [activeProjectId]);

  const openFolderEditor = (scope) => setAddingScope({
    projectId: scope.projectId ?? null,
    parentId: scope.parentId ?? null,
  });
  useEffect(() => setAddingScope(null), [activeProjectId]);
  const folderEditor = addingScope && (
    <InlineFolderNameEditor
      key={`${addingScope.projectId}:${addingScope.parentId}`}
      label={addingScope.parentId ? "Subfolder name" : "Folder name"}
      onCommit={(name) => createFolder({ name, ...addingScope })}
      onClose={() => setAddingScope(null)}
    />
  );

  const isRootDropValid = (dest, e) => {
    const isFolder = isFolderDragEvent(e) || Boolean(getFolderDragData(e));
    if (!isFolder && !isAdmin) return false;
    if (isFolder) {
      if (dest.type === "global_unsorted" || dest.type === "project_unsorted") {
        return false;
      }
    }
    return true;
  };

  const handleDragEnterRoot = (key, dest) => (e) => {
    rootCounterMap.current.set(key, (rootCounterMap.current.get(key) || 0) + 1);
    const valid = isRootDropValid(dest, e);
    setDragOverRoot(key);
    setDragOverValid(valid);
  };

  const handleDragOverRoot = (key, dest) => (e) => {
    e.preventDefault();
    e.stopPropagation();
    const valid = isRootDropValid(dest, e);
    e.dataTransfer.dropEffect = valid ? "move" : "none";
    if (dragOverRoot !== key) setDragOverRoot(key);
    if (dragOverValid !== valid) setDragOverValid(valid);
  };

  const handleDragLeaveRoot = (key) => (e) => {
    e.preventDefault();
    e.stopPropagation();
    const count = Math.max(0, (rootCounterMap.current.get(key) || 0) - 1);
    rootCounterMap.current.set(key, count);
    if (count === 0 && dragOverRoot === key) {
      setDragOverRoot(null);
      setDragOverValid(true);
    }
  };

  const handleDropOnRoot = (dest, _key) => (e) => {
    e.preventDefault();
    e.stopPropagation();
    rootCounterMap.current.clear();
    setDragOverRoot(null);
    setDragOverValid(true);

    if (!isRootDropValid(dest, e)) {
      if (getFolderDragData(e)) notify("Folders cannot be moved into Unsorted.");
      return;
    }

    const assetPayload = getAssetDragData(e, useStore.getState());
    const folderId = getFolderDragData(e);

    if (assetPayload.ids.length > 0) {
      moveGenerationsToDestination(assetPayload.ids, dest).catch((err) =>
        notify(err.message || "Failed to move items.")
      );
    } else if (folderId) {
      moveFolder(folderId, dest).catch((err) =>
        notify(err.message || "Failed to move folder.")
      );
    }
  };

  const openMoveModalForFolder = (folder) => {
    setMovingFolder(folder);
    setMoveModalOpen(true);
  };

  const onConfirmFolderMove = async (destination) => {
    if (!movingFolder) return;
    await moveFolder(movingFolder.id, destination);
  };

  const filtering = Boolean(search.trim()) || filterKind !== "all";

  // Derive active folder name for empty state
  const activeFolderName = useMemo(() => {
    if (activeFolderId === null) return null;
    if (activeFolderId === UNSORTED) return "Unsorted";
    function findName(nodes) {
      for (const n of nodes) {
        if (n.id === activeFolderId) return n.name;
        if (n.children?.length) {
          const res = findName(n.children);
          if (res) return res;
        }
      }
      return null;
    }
    const all = [
      ...(libraryTree?.globalFolders ?? []),
      ...(libraryTree?.projects?.flatMap((p) => p.folders ?? []) ?? []),
    ];
    return findName(all) || "Folder";
  }, [activeFolderId, libraryTree]);

  // Project Folders Tree
  const projectFoldersTree = useMemo(() => {
    if (!project) return [];
    const projData = libraryTree?.projects?.find((p) => p.id === project.id);
    return projData?.folders ?? [];
  }, [project, libraryTree]);

  // Global Folders Tree
  const globalFoldersTree = useMemo(() => {
    return libraryTree?.globalFolders ?? [];
  }, [libraryTree]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-0 flex-1">
        {/* Navigation Rail */}
        <div className="flex min-h-0 w-[290px] max-w-[45vw] shrink-0 flex-col border-r border-line select-none">
        <div className="scroll-thin min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden p-2">
          {/* ── GLOBAL LIBRARY SECTION ── */}
          <div className="mb-4 space-y-1">
            <div className="flex items-center justify-between px-1.5 py-1">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-white/40">
                Global Library
              </span>
              <button
                type="button"
                onClick={() => openFolderEditor({ projectId: null, parentId: null })}
                className="grid h-5 w-5 place-items-center rounded text-white/40 transition hover:bg-white/10 hover:text-white"
                title="New global folder"
                aria-label="New global folder"
              >
                <FolderPlus className="h-3.5 w-3.5" />
              </button>
            </div>

            {/* Global Library Root */}
            <FolderRow
              label="All Global"
              count={counts.globalLibrary?.total}
              icon={<Layers className="h-4 w-4" />}
              active={!briefView && activeProjectId === null && activeFolderId === null}
              dragOver={dragOverRoot === "global_root"}
              dragOverValid={dragOverValid}
              onDragEnter={handleDragEnterRoot("global_root", { type: "global_root" })}
              onDragOver={handleDragOverRoot("global_root", { type: "global_root" })}
              onDragLeave={handleDragLeaveRoot("global_root")}
              onDrop={handleDropOnRoot({ type: "global_root" }, "global_root")}
              onClick={() => {
                setBriefView(false);
                setActiveProject(null);
                setActiveFolder(null);
              }}
            />

            {/* Adding root global folder input */}
            {addingScope && addingScope.projectId === null && addingScope.parentId === null && (
              folderEditor
            )}

            {/* Hierarchical Global Folders Tree */}
            <FolderTree
              folders={globalFoldersTree}
              activeFolderId={activeProjectId === null ? activeFolderId : null}
              countsByFolder={counts.globalLibrary?.byFolder ?? {}}
              projectId={null}
              onSelectFolder={(fId) => {
                setBriefView(false);
                setActiveProject(null);
                setActiveFolder(fId);
              }}
              onOpenMoveModal={openMoveModalForFolder}
              onOpenNewFolderModal={(opts) => openFolderEditor(opts)}
            />

            {/* Adding subfolder input */}
            {addingScope && addingScope.projectId === null && addingScope.parentId !== null && (
              folderEditor
            )}


          </div>

          {/* ── ACTIVE PROJECT WORKSPACE SECTION ── */}
          {project ? (
            <div className="border-t border-line/60 pt-3 space-y-1">
              <div className="flex items-center justify-between px-1.5 py-1">
                <span
                  className="text-[10px] font-semibold uppercase tracking-wider text-white/40 truncate max-w-[8.5rem]"
                  title={`Active Project: ${project.name}`}
                >
                  {project.name}
                </span>
                <button
                  type="button"
                  onClick={() => openFolderEditor({ projectId: project.id, parentId: null })}
                  className="grid h-5 w-5 place-items-center rounded text-white/40 transition hover:bg-white/10 hover:text-white"
                  title="New project folder"
                  aria-label="New project folder"
                >
                  <FolderPlus className="h-3.5 w-3.5" />
                </button>
              </div>

              {/* Active Project Root / All Assets */}
              <FolderRow
                label="All Assets"
                count={counts.project?.total}
                icon={<Layers className="h-4 w-4" />}
                active={!briefView && activeFolderId === null}
                dragOver={dragOverRoot === `project_${project.id}`}
                dragOverValid={dragOverValid}
                onDragEnter={handleDragEnterRoot(`project_${project.id}`, { type: "project_root", projectId: project.id })}
                onDragOver={handleDragOverRoot(`project_${project.id}`, { type: "project_root", projectId: project.id })}
                onDragLeave={handleDragLeaveRoot(`project_${project.id}`)}
                onDrop={handleDropOnRoot({ type: "project_root", projectId: project.id }, `project_${project.id}`)}
                onClick={() => {
                  setBriefView(false);
                  setActiveProject(project.id);
                  setActiveFolder(null);
                }}
                onRename={async () => {
                  const newName = await askText({ title: "Rename project", label: "Project name", defaultValue: project.name, confirmLabel: "Rename" });
                  if (newName && newName !== project.name) {
                    renameProject(project.id, newName);
                  }
                }}
                onDelete={async () => {
                  if (await askConfirm({ title: `Delete project "${project.name}"?`, description: "Its items move to the Global Library.", confirmLabel: "Delete project", destructive: true })) {
                    deleteProject(project.id);
                  }
                }}
              />

              {/* Project Brief */}
              <FolderRow
                label="Project brief"
                icon={<FileText className="h-3.5 w-3.5" />}
                active={briefView}
                onClick={() => {
                  setActiveProject(project.id);
                  setBriefView(true);
                }}
              />

              {/* Folders Section Subheader */}
              <div className="flex items-center justify-between px-1.5 pt-1.5 pb-0.5">
                <span className="text-[10px] font-medium uppercase tracking-wide text-white/35">
                  Folders
                </span>
                <button
                  type="button"
                  onClick={() => openFolderEditor({ projectId: project.id, parentId: null })}
                  className="grid h-4 w-4 place-items-center rounded text-white/45 transition hover:bg-white/10 hover:text-white"
                  aria-label="New project folder"
                  title="New project folder"
                >
                  <FolderPlus className="h-3 w-3" />
                </button>
              </div>

              {/* Adding root project folder input */}
              {addingScope && addingScope.projectId === project.id && addingScope.parentId === null && (
                folderEditor
              )}

              {/* Hierarchical Project Folders Tree */}
              <FolderTree
                folders={projectFoldersTree}
                activeFolderId={activeFolderId}
                countsByFolder={counts.project?.byFolder ?? {}}
                projectId={project.id}
                onSelectFolder={(fId) => {
                  setBriefView(false);
                  setActiveProject(project.id);
                  setActiveFolder(fId);
                }}
                onOpenMoveModal={openMoveModalForFolder}
                onOpenNewFolderModal={(opts) => openFolderEditor(opts)}
              />

              {/* Adding subfolder input */}
              {addingScope && addingScope.projectId === project.id && addingScope.parentId !== null && (
                folderEditor
              )}


            </div>
          ) : (
            <div className="border-t border-line/60 pt-3 px-1.5 space-y-2">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-white/40">
                Workspace
              </span>
              <p className="text-xs text-white/40 leading-relaxed">
                Global Library is active. Switch to a project using the selector above to open a project workspace.
              </p>
            </div>
          )}
        </div>
        <div data-testid="sticky-unsorted-rail" className="shrink-0 border-t border-line bg-ink-850 p-2">
            {/* Global Unsorted */}
            <FolderRow
              label="Unsorted"
              count={counts.globalLibrary?.unsorted ?? 0}
              icon={<Inbox className="h-4 w-4" />}
              active={!briefView && activeProjectId === null && activeFolderId === UNSORTED}
              dragOver={dragOverRoot === "global_unsorted"}
              dragOverValid={dragOverValid}
              onDragEnter={handleDragEnterRoot("global_unsorted", { type: "global_unsorted" })}
              onDragOver={handleDragOverRoot("global_unsorted", { type: "global_unsorted" })}
              onDragLeave={handleDragLeaveRoot("global_unsorted")}
              onDrop={handleDropOnRoot({ type: "global_unsorted" }, "global_unsorted")}
              onClick={() => {
                setBriefView(false);
                setActiveProject(null);
                setActiveFolder(UNSORTED);
              }}
            />
{project && <>
              {/* Project Unsorted */}
              <FolderRow
                label="Unsorted"
                count={counts.project?.unsorted ?? 0}
                icon={<Inbox className="h-3.5 w-3.5" />}
                active={!briefView && activeFolderId === UNSORTED}
                dragOver={dragOverRoot === "project_unsorted"}
                dragOverValid={dragOverValid}
                onDragEnter={handleDragEnterRoot("project_unsorted", { type: "project_unsorted", projectId: project.id })}
                onDragOver={handleDragOverRoot("project_unsorted", { type: "project_unsorted", projectId: project.id })}
                onDragLeave={handleDragLeaveRoot("project_unsorted")}
                onDrop={handleDropOnRoot({ type: "project_unsorted", projectId: project.id }, "project_unsorted")}
                onClick={() => {
                  setBriefView(false);
                  setActiveProject(project.id);
                  setActiveFolder(UNSORTED);
                }}
              />
</>}
        </div>
        <FolderOperationRail />
        </div>

        {/* Main Content Area */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-ink-900">
          {briefView && project ? (
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              <BriefEditor projectId={project.id} brief={project.brief ?? ""} />
            </div>
          ) : (
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              {/* Dynamic Navigable Breadcrumb Bar */}
              <div className="border-b border-line bg-ink-850 px-4 py-2">
                <BreadcrumbBar
                  onOpenMoveModal={openMoveModalForFolder}
                  onOpenNewFolderModal={() =>
                    openFolderEditor({
                      projectId: activeProjectId,
                      parentId: activeFolderId === UNSORTED ? null : activeFolderId,
                    })
                  }
                />
              </div>

              {/* Immediate Child Folders (Finder-style Coexistence, hidden when in Unsorted) */}
              {activeFolderId !== UNSORTED && (
                <ChildFolderList
                  parentId={activeFolderId}
                  projectId={activeProjectId}
                  onOpenMoveModal={openMoveModalForFolder}
                  onOpenNewFolderModal={() =>
                    openFolderEditor({
                      projectId: activeProjectId,
                      parentId: activeFolderId,
                    })
                  }
                />
              )}

              {/* Directly Contained Generations Grid */}
              <AssetGrid
                items={items}
                loading={loading}
                cardWidth={cardWidth}
                empty={
                  <EmptyProject
                    filtering={filtering}
                    folderName={activeFolderName}
                  />
                }
                renderItem={(item) => (
                  <MediaCard key={item.id} item={item} selectable />
                )}
              />
            </div>
          )}
        </div>
      </div>

      {/* Destination Picker Modal */}
      <DestinationPickerModal
        open={moveModalOpen}
        onClose={() => {
          setMoveModalOpen(false);
          setMovingFolder(null);
        }}
        title={movingFolder ? `Move folder "${movingFolder.name}"` : "Move to..."}
        movingFolderId={movingFolder?.id || null}
        movingFolderCurrentParentId={movingFolder?.parentId || null}
        onConfirm={onConfirmFolderMove}
      />
    </div>
  );
}

function EmptyProject({
  filtering,
  folderName,
}) {
  if (filtering) {
    return (
      <EmptyState
        icon={<SearchIcon className="h-6 w-6" />}
        title="No matches"
        body={
          folderName
            ? `Nothing in ${folderName} matches the current search and type filter.`
            : "Nothing in this location matches the current search and type filter."
        }
      />
    );
  }
  return (
    <EmptyState
      icon={<FolderClosed className="h-6 w-6 text-amber-400/70" />}
      title={folderName ? `${folderName} is empty` : "This library is empty"}
      body={
        folderName
          ? "Generate while this folder is selected, or drag items and subfolders in."
          : "Generate or organize assets using folders to structure your library."
      }
    />
  );
}

export function EmptyState({
  icon,
  title,
  body,
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2.5 px-6 text-center">
      <div className="grid h-12 w-12 place-items-center rounded-2xl bg-ink-700 text-white/40 ring-1 ring-line">
        {icon}
      </div>
      <p className="text-sm font-medium text-white/75">{title}</p>
      <p className="max-w-[22rem] text-[13px] leading-relaxed text-white/40">{body}</p>
    </div>
  );
}

function FolderRow({
  label,
  count,
  icon,
  active,
  dragOver,
  dragOverValid = true,
  onClick,
  onDragEnter,
  onDragOver,
  onDragLeave,
  onDrop,
  onRename,
  onDelete,
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.target === e.currentTarget && ["Enter", " "].includes(e.key)) { e.preventDefault(); onClick?.(); } }}
      onClick={onClick}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      title={label}
      className={cn(
        "group flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-xs transition",
        active ? "bg-brand/15 text-white font-medium" : "text-white/65 hover:bg-white/5",
        dragOver &&
          (dragOverValid !== false
            ? "bg-brand/20 ring-1 ring-brand/60 text-white font-medium"
            : "bg-red-500/20 ring-1 ring-red-500/60 text-red-300 cursor-not-allowed")
      )}
    >
      <span className={cn("shrink-0", active ? "text-brand" : "text-white/45")}>
        {icon}
      </span>
      <span className="flex-1 truncate">{label}</span>
      {(onRename || onDelete) && (
        <span className="hidden items-center gap-0.5 group-hover:flex">
          {onRename && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onRename();
              }}
              className="grid h-5 w-5 place-items-center rounded text-white/50 hover:bg-white/10 hover:text-white"
              aria-label={`Rename ${label}`}
            >
              <Pencil className="h-3 w-3" />
            </button>
          )}
          {onDelete && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDelete();
              }}
              className="grid h-5 w-5 place-items-center rounded text-white/50 hover:bg-red-500/15 hover:text-red-300"
              aria-label={`Delete ${label}`}
            >
              <Trash2 className="h-3 w-3" />
            </button>
          )}
        </span>
      )}
      {count !== undefined && (
        <span
          className={cn(
            "text-[10px] tabular-nums",
            active ? "text-white/55" : "text-white/35",
            (onRename || onDelete) && "group-hover:hidden"
          )}
        >
          {count}
        </span>
      )}
    </div>
  );
}

export function BriefEditor({ projectId, brief }) {
  const [text, setText] = useState(brief);
  const [state, setState] = useState("idle");
  const initial = useRef(brief);

  useEffect(() => {
    setText(brief);
    initial.current = brief;
    setState("idle");
  }, [projectId, brief]);

  const save = async () => {
    if (text === initial.current) return;
    setState("saving");
    try {
      await apiFetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ op: "setBrief", projectId, brief: text }),
      });
      initial.current = text;
      setState("saved");
    } catch {
      setState("idle");
    }
  };

  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex items-center justify-between">
        <p className="text-[11px] font-medium uppercase tracking-wide text-white/40">
          Project brief
        </p>
        <span className="flex items-center gap-1.5 text-[11px] text-white/35">
          {state === "saving" && (
            <>
              <Loader2 className="h-3 w-3 animate-spin" /> Saving…
            </>
          )}
          {state === "saved" && "Saved"}
          {state === "idle" && text !== initial.current && "Unsaved"}
        </span>
      </div>
      <textarea
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          if (state === "saved") setState("idle");
        }}
        onBlur={save}
        placeholder="Notes, references, direction, shot list…"
        className="flex-1 resize-none rounded-lg border border-line bg-ink-800 p-3 text-sm leading-relaxed text-white outline-none placeholder:text-white/30 focus:border-brand/40"
      />
    </div>
  );
}
