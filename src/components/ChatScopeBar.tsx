"use client";

import { ChevronDown, Layers, LayoutGrid, PanelRightOpen, Star } from "lucide-react";
import { useStore } from "@/lib/store";
import { Dropdown } from "./Dropdown";
import { ProjectMenu } from "./ProjectMenu";
import { cn } from "@/lib/utils";
import type { FeedTab } from "@/lib/feed-scope";

/**
 * Standing in for the assets panel while it is collapsed.
 *
 * The panel now starts closed, so everything it was the only route to had to
 * reappear somewhere: which project you are working in, and a way back to the
 * library. This strip carries exactly that and nothing else — it is a shortcut,
 * not a second control surface.
 *
 * It unmounts the moment the panel opens, which is what "the shortcuts merge"
 * means in practice: the project switcher is never on screen twice, and the
 * counts here are the same store values the panel's tabs show, so they cannot
 * disagree. The switcher's menu is literally the same component (ProjectMenu).
 */
export function ChatScopeBar() {
  const rightPanelOpen = useStore((s) => s.rightPanelOpen);
  const setRightPanelOpen = useStore((s) => s.setRightPanelOpen);
  const setRightTab = useStore((s) => s.setRightTab);
  const setMobileHistoryOpen = useStore((s) => s.setMobileHistoryOpen);
  const projects = useStore((s) => s.projects);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const counts = useStore((s) => s.counts);

  // While the panel is open it owns all of this.
  if (rightPanelOpen) return null;

  const project = projects.find((p) => p.id === activeProjectId) ?? null;

  const openPanel = (tab: FeedTab) => {
    setRightTab(tab);
    setRightPanelOpen(true);
    // Below `lg` the docked panel is display:none and the library lives in a
    // drawer instead, so setting only `rightPanelOpen` there would appear to do
    // nothing at all. Guarded by the same 1024px breakpoint page.tsx uses.
    if (
      typeof window !== "undefined" &&
      !window.matchMedia("(min-width: 1024px)").matches
    ) {
      setMobileHistoryOpen(true);
    }
  };

  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-2 sm:px-8">
      {/* Project: the name opens the project view, the chevron switches
          project — the same split as the panel's own scope bar, so the gesture
          transfers when the panel is open. */}
      <div className="flex min-w-0 items-center rounded-full bg-ink-800 ring-1 ring-line">
        <button
          onClick={() => openPanel("project")}
          title={project ? `Open ${project.name}` : "No project yet"}
          className="flex min-w-0 items-center gap-1.5 rounded-l-full py-1.5 pl-3 pr-1.5 text-sm font-medium text-white/80 transition hover:text-white"
        >
          <Layers className="h-4 w-4 shrink-0 text-white/50" />
          <span className="max-w-[11rem] truncate">
            {project ? project.name : "No project"}
          </span>
          {counts.project.total > 0 && (
            <span className="shrink-0 rounded-full bg-white/[0.08] px-1.5 text-[11px] font-medium tabular-nums text-white/50">
              {counts.project.total}
            </span>
          )}
        </button>
        <Dropdown
          label="Switch project"
          trigger={(open) => (
            <span
              title="Switch project"
              className={cn(
                "grid h-7 w-7 place-items-center rounded-full text-white/45 transition hover:bg-white/10 hover:text-white",
                open && "bg-white/10 text-white"
              )}
            >
              <ChevronDown
                className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")}
              />
            </span>
          )}
        >
          {(close) => <ProjectMenu close={close} />}
        </Dropdown>
      </div>

      <ShortcutButton
        onClick={() => openPanel("history")}
        icon={<LayoutGrid className="h-4 w-4" />}
        label="All assets"
        count={counts.allAssets}
      />
      <ShortcutButton
        onClick={() => openPanel("favorites")}
        icon={<Star className="h-4 w-4" />}
        label="Favourites"
        count={counts.favorites}
      />

      <button
        onClick={() => setRightPanelOpen(true)}
        title="Show assets panel"
        aria-label="Show assets panel"
        className="ml-auto grid h-8 w-8 shrink-0 place-items-center rounded-lg text-white/45 transition hover:bg-white/[0.07] hover:text-white"
      >
        <PanelRightOpen className="h-4 w-4" />
      </button>
    </div>
  );
}

function ShortcutButton({
  onClick,
  icon,
  label,
  count,
}: {
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  count: number;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      className="flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1.5 text-sm text-white/55 transition hover:bg-white/[0.06] hover:text-white"
    >
      {icon}
      {/* Dropped first when the chat column is narrow — the icon and the count
          still identify it, and the project name is the more useful label. */}
      <span className="chat-scope-label whitespace-nowrap">{label}</span>
      {count > 0 && (
        <span className="text-[11px] font-medium tabular-nums text-white/35">
          {count}
        </span>
      )}
    </button>
  );
}
