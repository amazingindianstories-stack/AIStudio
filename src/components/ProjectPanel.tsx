"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  ChevronDown,
  Plus,
  FolderClosed,
  FolderPlus,
  Layers,
  FileText,
  Pencil,
  Trash2,
  Check,
  MoreHorizontal,
} from "lucide-react";
import { useStore } from "@/lib/store";
import { Dropdown, MenuItem } from "./Dropdown";
import { MediaCard } from "./MediaCard";
import { cn } from "@/lib/utils";

export function ProjectPanel() {
  const projects = useStore((s) => s.projects);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const activeFolderId = useStore((s) => s.activeFolderId);
  const items = useStore((s) => s.items);
  const search = useStore((s) => s.search);
  const filterKind = useStore((s) => s.filterKind);
  const setActiveProject = useStore((s) => s.setActiveProject);
  const setActiveFolder = useStore((s) => s.setActiveFolder);
  const createProject = useStore((s) => s.createProject);
  const renameProject = useStore((s) => s.renameProject);
  const deleteProject = useStore((s) => s.deleteProject);
  const createFolder = useStore((s) => s.createFolder);
  const renameFolder = useStore((s) => s.renameFolder);
  const deleteFolder = useStore((s) => s.deleteFolder);
  const moveItem = useStore((s) => s.moveItem);

  const [briefView, setBriefView] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newFolder, setNewFolder] = useState("");
  const [dragOver, setDragOver] = useState<string | null>(null);

  // Project views are subsets of the paginated history — keep paging while
  // the user scrolls so every item in the project/folder becomes visible.
  const loadMoreHistory = useStore((s) => s.loadMoreHistory);
  const hasMoreHistory = useStore((s) => s.hasMoreHistory);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const observerTarget = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const observer = new IntersectionObserver(
      async (entries) => {
        if (entries[0].isIntersecting && hasMoreHistory && !isLoadingMore) {
          setIsLoadingMore(true);
          await loadMoreHistory();
          setIsLoadingMore(false);
        }
      },
      { threshold: 0.1 }
    );
    if (observerTarget.current) observer.observe(observerTarget.current);
    return () => observer.disconnect();
  }, [hasMoreHistory, isLoadingMore, loadMoreHistory]);

  const project = projects.find((p) => p.id === activeProjectId) ?? null;

  const projectItems = useMemo(
    () => items.filter((i) => project && i.projectId === project.id),
    [items, project]
  );

  const countFor = (folderId: string | null) =>
    folderId === null
      ? projectItems.length
      : projectItems.filter((i) => i.folderId === folderId).length;

  const grid = useMemo(() => {
    const q = search.trim().toLowerCase();
    return projectItems
      .filter((i) =>
        activeFolderId === null ? true : i.folderId === activeFolderId
      )
      .filter((i) => (filterKind === "all" ? true : i.kind === filterKind))
      .filter((i) => (q ? i.prompt.toLowerCase().includes(q) : true));
  }, [projectItems, activeFolderId, filterKind, search]);

  const onAddFolder = async () => {
    const name = newFolder.trim();
    if (!name || !project) return;
    await createFolder(project.id, name);
    setNewFolder("");
    setAdding(false);
  };

  const handleDrop = (folderId: string | null) => (e: React.DragEvent) => {
    e.preventDefault();
    const id = e.dataTransfer.getData("text/itemId");
    setDragOver(null);
    if (id) moveItem(id, folderId);
  };

  if (!project) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <Layers className="h-7 w-7 text-white/35" />
        <p className="text-sm text-white/55">No project yet.</p>
        <button
          onClick={() => createProject("My Project")}
          className="rounded-lg bg-brand/20 px-3 py-1.5 text-sm font-semibold text-brand hover:bg-brand/30"
        >
          Create a project
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* project selector */}
      <div className="flex items-center gap-2 border-b border-line px-3 py-2.5">
        <Dropdown
          trigger={(open) => (
            <span
              className={cn(
                "flex cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm font-semibold text-white transition hover:bg-white/5",
                open && "bg-white/5"
              )}
            >
              <span className="grid h-5 w-5 place-items-center rounded bg-gradient-to-br from-brand/30 to-accent/10 text-brand ring-1 ring-brand/30">
                <Layers className="h-3 w-3" />
              </span>
              <span className="max-w-[160px] truncate">{project.name}</span>
              <ChevronDown
                className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")}
              />
            </span>
          )}
        >
          {(close) => (
            <>
              {projects.map((p) => (
                <MenuItem
                  key={p.id}
                  active={p.id === project.id}
                  onClick={() => {
                    setActiveProject(p.id);
                    setBriefView(false);
                    close();
                  }}
                >
                  <Layers className="h-4 w-4 text-white/45" />
                  <span className="flex-1 truncate">{p.name}</span>
                  {p.id === project.id && <Check className="h-4 w-4 text-brand" />}
                </MenuItem>
              ))}
              <div className="my-1 h-px bg-line" />
              <MenuItem
                onClick={() => {
                  const name = window.prompt("New project name");
                  if (name?.trim()) createProject(name.trim());
                  close();
                }}
              >
                <Plus className="h-4 w-4 text-white/60" /> New project
              </MenuItem>
            </>
          )}
        </Dropdown>

        <Dropdown
          align="right"
          className="ml-auto"
          trigger={(open) => (
            <span
              className={cn(
                "grid h-7 w-7 cursor-pointer place-items-center rounded-lg text-white/55 transition hover:bg-white/10 hover:text-white",
                open && "bg-white/10 text-white"
              )}
            >
              <MoreHorizontal className="h-4 w-4" />
            </span>
          )}
        >
          {(close) => (
            <>
              <MenuItem
                onClick={() => {
                  const name = window.prompt("Rename project", project.name);
                  if (name?.trim()) renameProject(project.id, name.trim());
                  close();
                }}
              >
                <Pencil className="h-4 w-4 text-white/60" /> Rename project
              </MenuItem>
              <MenuItem
                onClick={() => {
                  if (
                    window.confirm(
                      `Delete project "${project.name}"? Its items return to History.`
                    )
                  )
                    deleteProject(project.id);
                  close();
                }}
              >
                <Trash2 className="h-4 w-4 text-red-400/80" />
                <span className="text-red-300/90">Delete project</span>
              </MenuItem>
            </>
          )}
        </Dropdown>
      </div>

      {/* body: folder rail + grid */}
      <div className="flex min-h-0 flex-1">
        {/* folder rail */}
        <div className="flex w-40 shrink-0 flex-col gap-0.5 overflow-y-auto scroll-thin border-r border-line p-2">
          <FolderRow
            label="All assets"
            count={countFor(null)}
            icon={<Layers className="h-4 w-4" />}
            active={!briefView && activeFolderId === null}
            dragOver={dragOver === "all"}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver("all");
            }}
            onDragLeave={() => setDragOver(null)}
            onDrop={handleDrop(null)}
            onClick={() => {
              setBriefView(false);
              setActiveFolder(null);
            }}
          />
          <FolderRow
            label="Project brief"
            icon={<FileText className="h-4 w-4" />}
            active={briefView}
            onClick={() => setBriefView(true)}
          />

          <div className="mt-2 flex items-center justify-between px-1.5 py-1">
            <span className="text-[10px] font-medium uppercase tracking-wide text-white/35">
              Folders
            </span>
            <button
              onClick={() => setAdding((v) => !v)}
              className="grid h-5 w-5 place-items-center rounded text-white/45 hover:bg-white/10 hover:text-white"
            >
              <FolderPlus className="h-3.5 w-3.5" />
            </button>
          </div>

          {adding && (
            <input
              autoFocus
              value={newFolder}
              onChange={(e) => setNewFolder(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") onAddFolder();
                if (e.key === "Escape") {
                  setAdding(false);
                  setNewFolder("");
                }
              }}
              onBlur={onAddFolder}
              placeholder="Folder name"
              className="mb-1 w-full rounded-md border border-line bg-ink-800 px-2 py-1 text-xs text-white outline-none placeholder:text-white/30 focus:border-brand/40"
            />
          )}

          {project.folders.map((f) => (
            <FolderRow
              key={f.id}
              label={f.name}
              count={countFor(f.id)}
              icon={<FolderClosed className="h-4 w-4" />}
              active={!briefView && activeFolderId === f.id}
              dragOver={dragOver === f.id}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(f.id);
              }}
              onDragLeave={() => setDragOver(null)}
              onDrop={handleDrop(f.id)}
              onClick={() => {
                setBriefView(false);
                setActiveFolder(f.id);
              }}
              onRename={() => {
                const name = window.prompt("Rename folder", f.name);
                if (name?.trim()) renameFolder(project.id, f.id, name.trim());
              }}
              onDelete={() => {
                if (window.confirm(`Delete folder "${f.name}"? Items become unsorted.`))
                  deleteFolder(project.id, f.id);
              }}
            />
          ))}
        </div>

        {/* grid / brief */}
        <div className="min-h-0 flex-1 overflow-y-auto scroll-thin p-3">
          {briefView ? (
            <BriefEditor projectId={project.id} brief={project.brief ?? ""} />
          ) : grid.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-white/45">
              <FolderClosed className="h-6 w-6" />
              <p className="text-sm">
                Nothing here yet. Generate into this folder, or drag items in.
              </p>
            </div>
          ) : (
            <div className="columns-2 gap-3 [column-fill:_balance] xl:columns-3">
              <AnimatePresence mode="popLayout">
                {grid.map((item) => (
                  <div
                    key={item.id}
                    draggable
                    onDragStart={(e) =>
                      e.dataTransfer.setData("text/itemId", item.id)
                    }
                    className="mb-3 break-inside-avoid"
                  >
                    <MediaCard item={item} />
                  </div>
                ))}
              </AnimatePresence>
            </div>
          )}
          {!briefView && hasMoreHistory && (
            <div
              ref={observerTarget}
              className="flex h-16 w-full items-center justify-center opacity-50"
            >
              {isLoadingMore ? "Loading more..." : ""}
            </div>
          )}
        </div>
      </div>
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
}: {
  label: string;
  count?: number;
  icon: React.ReactNode;
  active: boolean;
  dragOver?: boolean;
  onClick: () => void;
  onDragOver?: (e: React.DragEvent) => void;
  onDragLeave?: () => void;
  onDrop?: (e: React.DragEvent) => void;
  onRename?: () => void;
  onDelete?: () => void;
}) {
  return (
    <div
      onClick={onClick}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={cn(
        "group flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition",
        active ? "bg-brand/15 text-white" : "text-white/65 hover:bg-white/5",
        dragOver && "ring-1 ring-brand/60 bg-brand/10"
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
            >
              <Trash2 className="h-3 w-3" />
            </button>
          )}
        </span>
      )}
      {count !== undefined && (
        <span className="text-[11px] tabular-nums text-white/35 group-hover:hidden">
          {count}
        </span>
      )}
    </div>
  );
}

function BriefEditor({ projectId, brief }: { projectId: string; brief: string }) {
  const [text, setText] = useState(brief);
  const save = async () => {
    await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op: "setBrief", projectId, brief: text }),
    });
  };
  return (
    <div className="flex h-full flex-col gap-2">
      <p className="text-[11px] font-medium uppercase tracking-wide text-white/40">
        Project brief
      </p>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={save}
        placeholder="Notes, references, direction, shot list…"
        className="flex-1 resize-none rounded-lg border border-line bg-ink-800 p-3 text-sm text-white outline-none placeholder:text-white/30 focus:border-brand/40"
      />
    </div>
  );
}
