"use client";

import { useState, useMemo } from "react";
import { Check, Layers, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { useStore } from "@/lib/store";
import { MenuItem } from "./Dropdown";
import { askConfirm, askText } from "@/lib/ask-text";

/**
 * Authoritative workspace / project switcher menu.
 * Provides instant search, quick switching between Global Library and projects,
 * project creation, and current project management (rename/delete).
 */
export function ProjectMenu({ close }) {
  const projects = useStore((s) => s.projects);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const setActiveProject = useStore((s) => s.setActiveProject);
  const setRightTab = useStore((s) => s.setRightTab);
  const createProject = useStore((s) => s.createProject);
  const renameProject = useStore((s) => s.renameProject);
  const deleteProject = useStore((s) => s.deleteProject);

  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const mutate = async (action) => { if (pending) return; setPending(true); setError(""); try { await action(); close(); } catch (err) { setError(err.message || "Project operation failed."); } finally { setPending(false); } };
  const [query, setQuery] = useState("");

  const project = projects.find((p) => p.id === activeProjectId) ?? null;

  const filteredProjects = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter((p) => p.name.toLowerCase().includes(q));
  }, [projects, query]);

  return (
    <div className="flex max-h-[calc(100dvh-5rem)] w-72 max-w-[calc(100vw-2rem)] flex-col overflow-hidden select-none">
      {/* Search Projects */}
      <div className="relative shrink-0 px-1 pb-1.5 pt-0.5">
        <Search className="pointer-events-none absolute left-3 top-3 h-3.5 w-3.5 text-white/40" />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search projects"
          placeholder="Search projects…"
          className="w-full rounded-lg border border-line bg-ink-850 py-1.5 pl-8 pr-2.5 text-xs text-white placeholder-white/40 outline-none focus:border-brand/60 focus:ring-1 focus:ring-brand/40"
          autoFocus
          onKeyDown={(e) => {
            if (e.key === " ") e.stopPropagation();
          }}
        />
      </div>

      <div className="my-1 h-px bg-line" />

      {/* Global Library Option */}
      {!query && (
        <>
          <MenuItem
            active={activeProjectId === null}
            onClick={() => {
              setActiveProject(null);
              setRightTab("project");
              close();
            }}
          >
            <Layers className="h-4 w-4 text-white/45" />
            <span className="flex-1 truncate font-medium">Global Library</span>
            {activeProjectId === null && <Check className="h-4 w-4 text-brand" />}
          </MenuItem>
          <div className="my-1 h-px bg-line" />
        </>
      )}

      {/* Projects List */}
      <div className="min-h-0 flex-1 max-h-56 overflow-y-auto scroll-thin py-0.5 space-y-0.5">
        {filteredProjects.length === 0 ? (
          <div className="px-3 py-2 text-center text-xs text-white/40">
            No projects found
          </div>
        ) : (
          filteredProjects.map((p) => (
            <MenuItem
              key={p.id}
              active={p.id === activeProjectId}
              onClick={() => {
                setActiveProject(p.id);
                setRightTab("project");
                close();
              }}
            >
              <Layers className="h-4 w-4 text-white/45" />
              <span title={p.name} className="min-w-0 flex-1 truncate">{p.name}</span>
              {p.id === activeProjectId && <Check className="h-4 w-4 text-brand" />}
            </MenuItem>
          ))
        )}
      </div>

      <div className="my-1 h-px bg-line" />

      <div data-testid="project-actions-footer" aria-busy={pending} inert={pending ? true : undefined} className="shrink-0 border-t border-line bg-ink-900 pt-1">
      {/* Project Actions */}
      <MenuItem
        maintenanceWrite
        onClick={async () => {
          const name = await askText({ title: "New project", label: "Project name", confirmLabel: "Create" });
          if (name) void mutate(() => createProject(name));
        }}
      >
        <Plus className="h-4 w-4 text-white/60" />
        <span className="flex-1">New project</span>
      </MenuItem>

      {project && (
        <>
          <MenuItem
            maintenanceWrite
        onClick={async () => {
              const name = await askText({ title: "Rename project", label: "Project name", defaultValue: project.name, confirmLabel: "Rename" });
              if (name && name !== project.name) void mutate(() => renameProject(project.id, name));
            }}
          >
            <Pencil className="h-4 w-4 text-white/60" />
            <span className="flex-1">Rename current project</span>
          </MenuItem>
          <MenuItem
            maintenanceWrite
        onClick={async () => {
              if (
                await askConfirm({ title: `Delete project "${project.name}"?`, description: "Its items move to the Global Library.", confirmLabel: "Delete project", destructive: true })
              )
                void mutate(() => deleteProject(project.id));
            }}
          >
            <Trash2 className="h-4 w-4 text-red-400/80" />
            <span className="flex-1 text-red-300/90">Delete current project</span>
          </MenuItem>
        </>
      )}
      </div>
      {pending && <p role="status" className="shrink-0 px-3 py-1 text-xs text-white/60">Saving project…</p>}
      {error && <p role="alert" className="shrink-0 px-3 py-1 text-xs text-red-400">{error}</p>}
    </div>
  );
}
