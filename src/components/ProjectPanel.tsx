"use client";

import { useEffect, useRef, useState } from "react";
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
import { MediaCard } from "./MediaCard";
import { AssetGrid } from "./AssetGrid";
import { UNSORTED } from "@/lib/feed-scope";
import { cn } from "@/lib/utils";

export function ProjectPanel({ cardWidth = 160 }: { cardWidth?: number }) {
  const projects = useStore((s) => s.projects);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const activeFolderId = useStore((s) => s.activeFolderId);
  // `items` is now this scope's server-filtered page, not a global window the
  // component has to filter down — so there is no useMemo chain here any more.
  const items = useStore((s) => s.items);
  const loading = useStore((s) => s.loading);
  const counts = useStore((s) => s.counts);
  const search = useStore((s) => s.search);
  const filterKind = useStore((s) => s.filterKind);
  const createProject = useStore((s) => s.createProject);
  const setActiveFolder = useStore((s) => s.setActiveFolder);
  const createFolder = useStore((s) => s.createFolder);
  const renameFolder = useStore((s) => s.renameFolder);
  const deleteFolder = useStore((s) => s.deleteFolder);
  const moveItem = useStore((s) => s.moveItem);

  const [briefView, setBriefView] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newFolder, setNewFolder] = useState("");
  const [dragOver, setDragOver] = useState<string | null>(null);

  const project = projects.find((p) => p.id === activeProjectId) ?? null;

  // Switching project must not leave the brief editor open over a different
  // project's brief.
  useEffect(() => {
    setBriefView(false);
  }, [activeProjectId]);

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

  const filtering = Boolean(search.trim()) || filterKind !== "all";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-0 flex-1">
        {/* folder rail */}
        <div className="scroll-thin flex w-[clamp(7.5rem,26%,11rem)] shrink-0 flex-col overflow-y-auto border-r border-line p-2">
          <FolderRow
            label="All in project"
            count={counts.project.total}
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

          <div className="mt-3 flex items-center justify-between px-1.5 py-1">
            <span className="text-[10px] font-medium uppercase tracking-wide text-white/35">
              Folders
            </span>
            <button
              onClick={() => setAdding((v) => !v)}
              className="grid h-5 w-5 place-items-center rounded text-white/45 transition hover:bg-white/10 hover:text-white"
              aria-label="New folder"
              title="New folder"
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

          <div className="flex flex-col gap-0.5">
            {project.folders.map((f) => (
              <FolderRow
                key={f.id}
                label={f.name}
                count={counts.project.byFolder[f.id] ?? 0}
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

            {project.folders.length === 0 && !adding && (
              <p className="px-1.5 py-1 text-[11px] leading-snug text-white/30">
                No folders yet — group shots, characters or locations here.
              </p>
            )}
          </div>

          {/* Items in the project that live in no folder. Previously invisible:
              "All in project" showed them mixed in with everything else and
              nothing offered them on their own, so filing a backlog meant
              scrolling the whole project looking for what was not yet sorted. */}
          {counts.project.unsorted > 0 && (
            <div className="mt-3 border-t border-line pt-2">
              <FolderRow
                label="Unsorted"
                count={counts.project.unsorted}
                icon={<Inbox className="h-4 w-4" />}
                active={!briefView && activeFolderId === UNSORTED}
                dragOver={dragOver === UNSORTED}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver(UNSORTED);
                }}
                onDragLeave={() => setDragOver(null)}
                onDrop={handleDrop(null)}
                onClick={() => {
                  setBriefView(false);
                  setActiveFolder(UNSORTED);
                }}
              />
            </div>
          )}
        </div>

        {/* grid / brief */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {briefView ? (
            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              <BriefEditor projectId={project.id} brief={project.brief ?? ""} />
            </div>
          ) : (
            <AssetGrid
              items={items}
              loading={loading}
              cardWidth={cardWidth}
              empty={
                <EmptyProject
                  filtering={filtering}
                  folderName={
                    activeFolderId === null
                      ? null
                      : activeFolderId === UNSORTED
                      ? "Unsorted"
                      : project.folders.find((f) => f.id === activeFolderId)?.name ?? null
                  }
                />
              }
              renderItem={(item) => (
                <div
                  draggable
                  onDragStart={(e) => e.dataTransfer.setData("text/itemId", item.id)}
                >
                  <MediaCard item={item} selectable />
                </div>
              )}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function EmptyProject({
  filtering,
  folderName,
}: {
  filtering: boolean;
  folderName: string | null;
}) {
  // Three genuinely different situations that all used to print the same
  // sentence, the most misleading being a search that matched nothing being
  // reported as "Nothing here yet".
  if (filtering) {
    return (
      <EmptyState
        icon={<SearchIcon className="h-6 w-6" />}
        title="No matches"
        body={
          folderName
            ? `Nothing in ${folderName} matches the current search and type filter.`
            : "Nothing in this project matches the current search and type filter."
        }
      />
    );
  }
  return (
    <EmptyState
      icon={<FolderClosed className="h-6 w-6" />}
      title={folderName ? `${folderName} is empty` : "This project is empty"}
      body={
        folderName
          ? "Generate while this folder is selected, or drag items in from another folder."
          : "Generations made while this project is selected land here."
      }
    />
  );
}

export function EmptyState({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
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
      title={label}
      className={cn(
        "group flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition",
        active ? "bg-brand/15 text-white" : "text-white/65 hover:bg-white/5",
        dragOver && "bg-brand/10 ring-1 ring-brand/60"
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
            "text-[11px] tabular-nums",
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

function BriefEditor({ projectId, brief }: { projectId: string; brief: string }) {
  const [text, setText] = useState(brief);
  const [state, setState] = useState<"idle" | "saving" | "saved">("idle");
  const initial = useRef(brief);

  // A different project's brief must replace the textarea's contents, which a
  // useState initialiser alone will not do — the component stays mounted.
  useEffect(() => {
    setText(brief);
    initial.current = brief;
    setState("idle");
  }, [projectId, brief]);

  const save = async () => {
    if (text === initial.current) return;
    setState("saving");
    try {
      await fetch("/api/projects", {
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
        {/* The old editor saved silently on blur, so there was no way to tell a
            saved brief from a lost one. */}
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
