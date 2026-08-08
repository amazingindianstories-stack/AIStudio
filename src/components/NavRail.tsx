"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Image as ImageIcon,
  Clapperboard,
  Shapes,
  LayoutGrid,
  History,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useStore } from "@/lib/store";
import { LegacyHistoryModal } from "./LegacyHistoryModal";

/**
 * Retractable left nav rail — replaces Sidebar.tsx. Same three destinations
 * (Image/Video/Board) plus two entries that used to live elsewhere: Library
 * (was a small edge tab on the right panel in page.tsx) and History (opens
 * the pre-redesign per-project generation feed, now off the main path since
 * StudioChat is chat-first — see LegacyHistoryModal.tsx).
 *
 * Collapsed to icons by default; hovering/focusing the rail expands it in
 * place to show labels, rather than a per-item tooltip (Sidebar.tsx's old
 * behavior) — one state for the whole rail instead of one per button.
 */
export function NavRail() {
  const mode = useStore((s) => s.mode);
  const setMode = useStore((s) => s.setMode);
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const rightPanelOpen = useStore((s) => s.rightPanelOpen);
  const setRightPanelOpen = useStore((s) => s.setRightPanelOpen);
  const [expanded, setExpanded] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

  const activeId = view === "canvas" ? "board" : mode === "image" ? "image" : "video";

  const destinations = [
    {
      id: "image",
      icon: ImageIcon,
      label: "Image",
      onClick: () => {
        setView("studio");
        setMode("image");
      },
    },
    {
      id: "video",
      icon: Clapperboard,
      label: "Video",
      onClick: () => {
        setView("studio");
        setMode("video");
      },
    },
    {
      id: "board",
      icon: Shapes,
      label: "Board",
      onClick: () => setView("canvas"),
    },
  ];

  return (
    <>
      <aside
        onMouseEnter={() => setExpanded(true)}
        onMouseLeave={() => setExpanded(false)}
        onFocus={() => setExpanded(true)}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setExpanded(false);
        }}
        className={cn(
          "z-30 hidden h-full shrink-0 flex-col gap-1 border-r border-line bg-ink-900 py-3 transition-[width] duration-200 sm:flex",
          expanded ? "w-48 items-stretch px-2" : "w-16 items-center"
        )}
      >
        {destinations.map((item) => (
          <NavItem
            key={item.id}
            icon={item.icon}
            label={item.label}
            active={item.id === activeId}
            expanded={expanded}
            onClick={item.onClick}
          />
        ))}

        <span className={cn("my-1 h-px bg-line", expanded ? "mx-2" : "w-6")} aria-hidden />

        <NavItem
          icon={LayoutGrid}
          label="Library"
          active={rightPanelOpen}
          expanded={expanded}
          onClick={() => setRightPanelOpen(!rightPanelOpen)}
        />
        <NavItem
          icon={History}
          label="History"
          active={historyOpen}
          expanded={expanded}
          onClick={() => setHistoryOpen(true)}
        />
      </aside>

      {historyOpen && <LegacyHistoryModal onClose={() => setHistoryOpen(false)} />}
    </>
  );
}

function NavItem({
  icon: Icon,
  label,
  active,
  expanded,
  onClick,
}: {
  icon: typeof ImageIcon;
  label: string;
  active: boolean;
  expanded: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={expanded ? undefined : label}
      className={cn(
        "relative flex shrink-0 items-center gap-3 rounded-xl transition-colors duration-200",
        expanded ? "h-11 w-full px-3" : "h-11 w-11 justify-center",
        active ? "text-white" : "text-white/45 hover:text-white/90 hover:bg-white/5"
      )}
    >
      {active && (
        <motion.span
          layoutId="nav-rail-active"
          transition={{ type: "spring", stiffness: 420, damping: 34 }}
          className="absolute inset-0 rounded-xl bg-gradient-to-br from-brand/25 to-brand/5 ring-1 ring-brand/40"
        />
      )}
      <Icon className="relative z-10 h-[19px] w-[19px] shrink-0" strokeWidth={1.9} />
      <AnimatePresence>
        {expanded && (
          <motion.span
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="relative z-10 whitespace-nowrap text-sm font-medium"
          >
            {label}
          </motion.span>
        )}
      </AnimatePresence>
    </button>
  );
}
