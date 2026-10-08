"use client";

import { useState, useMemo } from "react";
import { Check, Layers, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { useStore } from "@/lib/store";
import { MenuItem } from "./Dropdown";

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

  const [query, setQuery] = useState("");

  const project = projects.find((p) => p.id === activeProjectId) ?? null;

  const filteredProjects = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter((p) => p.name.toLowerCase().includes(q));
  }, [projects, query]);

  return (
    <div className="w-64 max-w-[calc(100vw-2rem)] select-none">
      {/* Search Projects */}
      <div className="relative px-1 pb-1.5 pt-0.5">
        <Search className="pointer-events-none absolute left-3 top-3 h-3.5 w-3.5 text-white/40" />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
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
      <div className="max-h-56 overflow-y-auto scroll-thin py-0.5 space-y-0.5">
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
              <span className="flex-1 truncate">{p.name}</span>
              {p.id === activeProjectId && <Check className="h-4 w-4 text-brand" />}
            </MenuItem>
          ))
        )}
      </div>

      <div className="my-1 h-px bg-line" />

      {/* Project Actions */}
      <MenuItem
        onClick={() => {
          const name = window.prompt("New project name");
          if (name?.trim()) createProject(name.trim());
          close();
        }}
      >
        <Plus className="h-4 w-4 text-white/60" />
        <span className="flex-1">New project</span>
      </MenuItem>

      {project && (
        <>
          <MenuItem
            onClick={() => {
              const name = window.prompt("Rename project", project.name);
              if (name?.trim()) renameProject(project.id, name.trim());
              close();
            }}
          >
            <Pencil className="h-4 w-4 text-white/60" />
            <span className="flex-1">Rename current project</span>
          </MenuItem>
          <MenuItem
            onClick={() => {
              if (
                window.confirm(
                  `Delete project "${project.name}"? Its items return to Global Library.`
                )
              )
                deleteProject(project.id);
              close();
            }}
          >
            <Trash2 className="h-4 w-4 text-red-400/80" />
            <span className="flex-1 text-red-300/90">Delete current project</span>
          </MenuItem>
        </>
      )}
    </div>
  );
}
