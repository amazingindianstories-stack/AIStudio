"use client";

import { ChevronDown, Check, Folder } from "lucide-react";
import { cn } from "@/lib/utils";
import { Dropdown, MenuItem } from "@/components/Dropdown";
import type { Project } from "@/lib/types";

/**
 * Explicit "which project owns the board I'm looking at" control (top-left,
 * beside BoardSwitcher). Added because the asset panel's scope filter and
 * the board's real owning project (`activeProjectId`) are two independent
 * things the UI previously let look like one — see the "Canvas Project
 * Context Is Misleading" bug report. Selecting here calls `setActiveProject`
 * directly; it never touches the asset-panel's own scope state.
 */
export function BoardProjectSelector({
  activeProjectId,
  projects,
  onChange,
}: {
  activeProjectId: string | null;
  projects: Project[];
  onChange: (projectId: string) => void;
}) {
  const current = projects.find((p) => p.id === activeProjectId);
  const label = current?.name ?? "Select project";

  return (
    <Dropdown
      trigger={(open) => (
        <span
          title="The project that owns the current board"
          className={cn(
            "flex max-w-[240px] items-center gap-1.5 rounded-full border border-line bg-ink-700 pl-3 pr-2 py-1.5 text-sm text-white/85 transition hover:text-white",
            open && "border-brand/40"
          )}
        >
          <Folder className="h-3.5 w-3.5 shrink-0 text-white/50" />
          <span className="truncate">
            Board project: <span className="font-medium text-white">{label}</span>
          </span>
          <ChevronDown className={cn("h-3.5 w-3.5 shrink-0 transition-transform", open && "rotate-180")} />
        </span>
      )}
    >
      {(close) => (
        <div className="w-56">
          {projects.map((p) => (
            <MenuItem
              key={p.id}
              active={p.id === activeProjectId}
              onClick={() => {
                if (p.id !== activeProjectId) onChange(p.id);
                close();
              }}
            >
              <Folder className="h-4 w-4 text-white/50" />
              <span className="flex-1 truncate">{p.name}</span>
              {p.id === activeProjectId && <Check className="h-4 w-4 shrink-0 text-brand" />}
            </MenuItem>
          ))}
        </div>
      )}
    </Dropdown>
  );
}
