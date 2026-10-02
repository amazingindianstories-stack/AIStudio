"use client";

import { useEffect, useRef, useState, useMemo } from "react";
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
  Plus,
  ChevronDown,
} from "lucide-react";
import { useStore } from "@/lib/store";
import { apiFetch } from "@/lib/api";
import { MediaCard } from "./MediaCard";
import { AssetGrid } from "./AssetGrid";
import { UNSORTED } from "@/lib/feed-scope";
import { cn } from "@/lib/utils";
import { FolderTree } from "./FolderTree";
import { BreadcrumbBar } from "./BreadcrumbBar";
import { ChildFolderList } from "./ChildFolderList";
import { DestinationPickerModal } from "./DestinationPickerModal";
import { Dropdown, MenuItem } from "./Dropdown";

export function ProjectPanel({ cardWidth = 160 }) {
  const projects = useStore((s) => s.projects);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const activeFolderId = useStore((s) => s.activeFolderId);
  const libraryTree = useStore((s) => s.libraryTree);
  const items = useStore((s) => s.items);
  const loading = useStore((s) => s.loading);
  const counts = useStore((s) => s.counts);
  const search = useStore((s) => s.search);
  const filterKind = useStore((s) => s.filterKind);
  const setActiveProject = useStore((s) => s.setActiveProject);
  const setActiveFolder = useStore((s) => s.setActiveFolder);
  const createProject = useStore((s) => s.createProject);
  const createFolder = useStore((s) => s.createFolder);
  const moveItem = useStore((s) => s.moveItem);
  const moveFolder = useStore((s) => s.moveFolder);

  const [briefView, setBriefView] = useState(false);
  const [addingScope, setAddingScope] = useState(null); // { projectId, parentId } or null
  const [newFolderName, setNewFolderName] = useState("");
  const [dragOverRoot, setDragOverRoot] = useState(null);

  // Move Modal State
  const [moveModalOpen, setMoveModalOpen] = useState(false);
  const [movingFolder, setMovingFolder] = useState(null);

  const project = projects.find((p) => p.id === activeProjectId) ?? null;

  // Switching project must close brief editor if opened
  useEffect(() => {
    setBriefView(false);
  }, [activeProjectId]);

  const onAddFolderSubmit = async () => {
    const name = newFolderName.trim();
    if (!name || !addingScope) {
      setAddingScope(null);
      setNewFolderName("");
      return;
    }
    try {
      await createFolder({
        name,
        projectId: addingScope.projectId || null,
        parentId: addingScope.parentId || null,
      });
    } catch (err) {
      alert(err.message || "Failed to create folder.");
    } finally {
      setNewFolderName("");
      setAddingScope(null);
    }
  };

  const handleDropOnRoot = (dest) => (e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOverRoot(null);
    const itemId = e.dataTransfer.getData("text/itemId");
    const folderId = e.dataTransfer.getData("text/folderId");

    if (itemId) {
      moveItem(itemId, dest).catch((err) => alert(err.message || "Failed to move item."));
    } else if (folderId) {
      moveFolder(folderId, dest).catch((err) => alert(err.message || "Failed to move folder."));
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
        <div className="scroll-thin flex w-[clamp(9rem,28%,12.5rem)] shrink-0 flex-col overflow-y-auto border-r border-line p-2 select-none">
          {/* ── GLOBAL LIBRARY SECTION ── */}
          <div className="mb-4 space-y-1">
            <div className="flex items-center justify-between px-1.5 py-1">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-white/40">
                Global Library
              </span>
              <button
                type="button"
                onClick={() => setAddingScope({ projectId: null, parentId: null })}
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
              onDragOver={(e) => {
                e.preventDefault();
                setDragOverRoot("global_root");
              }}
              onDragLeave={() => setDragOverRoot(null)}
              onDrop={handleDropOnRoot({ type: "global_root" })}
              onClick={() => {
                setBriefView(false);
                setActiveProject(null);
                setActiveFolder(null);
              }}
            />

            {/* Adding root global folder input */}
            {addingScope && addingScope.projectId === null && addingScope.parentId === null && (
              <input
                autoFocus
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onAddFolderSubmit();
                  if (e.key === "Escape") setAddingScope(null);
                }}
                onBlur={onAddFolderSubmit}
                placeholder="Folder name"
                className="my-1 w-full rounded-md border border-line bg-ink-800 px-2 py-1 text-xs text-white outline-none placeholder:text-white/30 focus:border-brand/40"
              />
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
              onOpenNewFolderModal={(opts) => setAddingScope(opts)}
            />

            {/* Adding subfolder input */}
            {addingScope && addingScope.projectId === null && addingScope.parentId !== null && (
              <input
                autoFocus
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onAddFolderSubmit();
                  if (e.key === "Escape") setAddingScope(null);
                }}
                onBlur={onAddFolderSubmit}
                placeholder="Subfolder name"
                className="my-1 w-full rounded-md border border-line bg-ink-800 px-2 py-1 text-xs text-white outline-none placeholder:text-white/30 focus:border-brand/40"
              />
            )}

            {/* Global Unsorted */}
            {(counts.globalLibrary?.unsorted > 0 || (activeProjectId === null && activeFolderId === UNSORTED)) && (
              <FolderRow
                label="Unsorted"
                count={counts.globalLibrary?.unsorted ?? 0}
                icon={<Inbox className="h-4 w-4" />}
                active={!briefView && activeProjectId === null && activeFolderId === UNSORTED}
                dragOver={dragOverRoot === "global_unsorted"}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOverRoot("global_unsorted");
                }}
                onDragLeave={() => setDragOverRoot(null)}
                onDrop={handleDropOnRoot({ type: "global_unsorted" })}
                onClick={() => {
                  setBriefView(false);
                  setActiveProject(null);
                  setActiveFolder(UNSORTED);
                }}
              />
            )}
          </div>

          {/* ── PROJECTS SECTION ── */}
          <div className="border-t border-line/60 pt-3 space-y-1">
            <div className="flex items-center justify-between px-1.5 py-1">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-white/40">
                Projects
              </span>
              <button
                type="button"
                onClick={() => {
                  const name = window.prompt("New project name");
                  if (name?.trim()) createProject(name.trim());
                }}
                className="grid h-5 w-5 place-items-center rounded text-white/40 transition hover:bg-white/10 hover:text-white"
                title="Create a project"
                aria-label="Create a project"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            </div>

            {/* Current Active Project Picker */}
            {projects.length > 0 && (
              <div className="mb-2">
                <Dropdown
                  align="left"
                  trigger={(_open) => (
                    <div
                      className={cn(
                        "flex items-center justify-between rounded-lg border border-line/60 bg-ink-800/80 px-2 py-1.5 text-xs text-white transition hover:bg-ink-750 cursor-pointer",
                        project && activeProjectId && "border-brand/40 text-brand font-medium"
                      )}
                    >
                      <span className="truncate">{project ? project.name : "Select project..."}</span>
                      <ChevronDown className="h-3 w-3 shrink-0 text-white/40" />
                    </div>
                  )}
                >
                  {(close) => (
                    <div className="py-1">
                      {projects.map((p) => (
                        <MenuItem
                          key={p.id}
                          active={p.id === activeProjectId}
                          onClick={() => {
                            setActiveProject(p.id);
                            close();
                          }}
                        >
                          <Layers className="h-3.5 w-3.5 text-white/45" />
                          <span className="truncate">{p.name}</span>
                        </MenuItem>
                      ))}
                    </div>
                  )}
                </Dropdown>
              </div>
            )}

            {/* If a project is selected, show its contents */}
            {project && (
              <div className="space-y-1">
                <FolderRow
                  label="All in project"
                  count={counts.project?.total}
                  icon={<Layers className="h-4 w-4" />}
                  active={!briefView && activeProjectId === project.id && activeFolderId === null}
                  dragOver={dragOverRoot === "project_root"}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragOverRoot("project_root");
                  }}
                  onDragLeave={() => setDragOverRoot(null)}
                  onDrop={handleDropOnRoot({ type: "project_root", projectId: project.id })}
                  onClick={() => {
                    setBriefView(false);
                    setActiveProject(project.id);
                    setActiveFolder(null);
                  }}
                />

                <FolderRow
                  label="Project brief"
                  icon={<FileText className="h-4 w-4" />}
                  active={briefView && activeProjectId === project.id}
                  onClick={() => {
                    setActiveProject(project.id);
                    setBriefView(true);
                  }}
                />

                <div className="flex items-center justify-between px-1.5 pt-2 pb-0.5">
                  <span className="text-[10px] font-medium uppercase tracking-wide text-white/35">
                    Folders
                  </span>
                  <button
                    type="button"
                    onClick={() => setAddingScope({ projectId: project.id, parentId: null })}
                    className="grid h-5 w-5 place-items-center rounded text-white/45 transition hover:bg-white/10 hover:text-white"
                    title="New project folder"
                  >
                    <FolderPlus className="h-3.5 w-3.5" />
                  </button>
                </div>

                {/* Adding root project folder input */}
                {addingScope && addingScope.projectId === project.id && addingScope.parentId === null && (
                  <input
                    autoFocus
                    value={newFolderName}
                    onChange={(e) => setNewFolderName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") onAddFolderSubmit();
                      if (e.key === "Escape") setAddingScope(null);
                    }}
                    onBlur={onAddFolderSubmit}
                    placeholder="Folder name"
                    className="my-1 w-full rounded-md border border-line bg-ink-800 px-2 py-1 text-xs text-white outline-none placeholder:text-white/30 focus:border-brand/40"
                  />
                )}

                {/* Hierarchical Project Folders Tree */}
                <FolderTree
                  folders={projectFoldersTree}
                  activeFolderId={activeProjectId === project.id ? activeFolderId : null}
                  countsByFolder={counts.project?.byFolder ?? {}}
                  projectId={project.id}
                  onSelectFolder={(fId) => {
                    setBriefView(false);
                    setActiveProject(project.id);
                    setActiveFolder(fId);
                  }}
                  onOpenMoveModal={openMoveModalForFolder}
                  onOpenNewFolderModal={(opts) => setAddingScope(opts)}
                />

                {/* Adding subfolder input */}
                {addingScope && addingScope.projectId === project.id && addingScope.parentId !== null && (
                  <input
                    autoFocus
                    value={newFolderName}
                    onChange={(e) => setNewFolderName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") onAddFolderSubmit();
                      if (e.key === "Escape") setAddingScope(null);
                    }}
                    onBlur={onAddFolderSubmit}
                    placeholder="Subfolder name"
                    className="my-1 w-full rounded-md border border-line bg-ink-800 px-2 py-1 text-xs text-white outline-none placeholder:text-white/30 focus:border-brand/40"
                  />
                )}

                {/* Project Unsorted */}
                {(counts.project?.unsorted > 0 || (activeProjectId === project.id && activeFolderId === UNSORTED)) && (
                  <FolderRow
                    label="Unsorted"
                    count={counts.project?.unsorted ?? 0}
                    icon={<Inbox className="h-4 w-4" />}
                    active={!briefView && activeProjectId === project.id && activeFolderId === UNSORTED}
                    dragOver={dragOverRoot === "project_unsorted"}
                    onDragOver={(e) => {
                      e.preventDefault();
                      setDragOverRoot("project_unsorted");
                    }}
                    onDragLeave={() => setDragOverRoot(null)}
                    onDrop={handleDropOnRoot({ type: "project_unsorted", projectId: project.id })}
                    onClick={() => {
                      setBriefView(false);
                      setActiveProject(project.id);
                      setActiveFolder(UNSORTED);
                    }}
                  />
                )}
              </div>
            )}
          </div>
        </div>

        {/* Main Content Area */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-ink-900">
          {briefView && project ? (
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              <BriefEditor projectId={project.id} brief={project.brief ?? ""} />
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col">
              {/* Dynamic Navigable Breadcrumb Bar */}
              <BreadcrumbBar
                onOpenMoveModal={openMoveModalForFolder}
                onOpenNewFolderModal={() =>
                  setAddingScope({
                    projectId: activeProjectId,
                    parentId: activeFolderId === UNSORTED ? null : activeFolderId,
                  })
                }
              />

              {/* Immediate Child Folders (Finder-style Coexistence) */}
              <ChildFolderList
                parentId={activeFolderId === UNSORTED ? null : activeFolderId}
                projectId={activeProjectId}
                onOpenMoveModal={openMoveModalForFolder}
                onOpenNewFolderModal={() =>
                  setAddingScope({
                    projectId: activeProjectId,
                    parentId: activeFolderId === UNSORTED ? null : activeFolderId,
                  })
                }
              />

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
                  <div
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData("text/itemId", item.id);
                      e.dataTransfer.setData("text/plain", item.url || "");
                      e.dataTransfer.effectAllowed = "copy";
                      useStore.getState().setDraggedItem(item);
                    }}
                    onDragEnd={() => {
                      useStore.getState().setDraggedItem(null);
                    }}
                  >
                    <MediaCard item={item} selectable />
                  </div>
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
  onClick,
  onDragOver,
  onDragLeave,
  onDrop,
  onRename,
  onDelete,
}) {
  return (
    <div
      onClick={onClick}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      title={label}
      className={cn(
        "group flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-xs transition",
        active ? "bg-brand/15 text-white font-medium" : "text-white/65 hover:bg-white/5",
        dragOver && "bg-brand/20 ring-1 ring-brand/60"
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

function BriefEditor({ projectId, brief }) {
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
