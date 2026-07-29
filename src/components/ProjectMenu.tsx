"use client";

import { Check, Layers, Pencil, Plus, Trash2 } from "lucide-react";
import { useStore } from "@/lib/store";
import { MenuItem } from "./Dropdown";

/**
 * The project switcher's menu body — the list plus new/rename/delete.
 *
 * Shared rather than duplicated because it now has two entry points: the assets
 * panel's scope bar, and the chat header's shortcut strip that stands in for it
 * while that panel is collapsed. Two copies would drift the moment one gained
 * an action, and "the shortcuts should merge" is only true if they are the same
 * control rendered in two places.
 *
 * Only the menu is shared. Each site draws its own trigger, because they differ
 * on purpose: the scope bar's doubles as a tab, the chat one is a plain pill.
 */
export function ProjectMenu({ close }: { close: () => void }) {
  const projects = useStore((s) => s.projects);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const setActiveProject = useStore((s) => s.setActiveProject);
  const setRightTab = useStore((s) => s.setRightTab);
  const createProject = useStore((s) => s.createProject);
  const renameProject = useStore((s) => s.renameProject);
  const deleteProject = useStore((s) => s.deleteProject);

  const project = projects.find((p) => p.id === activeProjectId) ?? null;

  return (
    <>
      {projects.map((p) => (
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
      {project && (
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
                  `Delete project "${project.name}"? Its items return to All assets.`
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
    </>
  );
}
