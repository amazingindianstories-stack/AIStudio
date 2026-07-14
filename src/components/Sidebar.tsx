"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import { Image as ImageIcon, Clapperboard, Shapes } from "lucide-react";
import { cn } from "@/lib/utils";
import { useStore } from "@/lib/store";

// Only the functional mode switches — the rest were non-working stubs.
const topItems = [
  { id: "image", icon: ImageIcon, label: "AI Image", mode: "image" as const },
  { id: "video", icon: Clapperboard, label: "AI Video", mode: "video" as const },
];

export function Sidebar() {
  const mode = useStore((s) => s.mode);
  const setMode = useStore((s) => s.setMode);
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const [hovered, setHovered] = useState<string | null>(null);

  // The active pill lives on exactly one item: the Board view when it's
  // open, otherwise whichever generation mode is selected.
  const activeId = view === "canvas" ? "board" : mode === "image" ? "image" : "video";

  const renderItem = (item: {
    id: string;
    icon: typeof ImageIcon;
    label: string;
    onClick: () => void;
  }) => {
    const isActive = item.id === activeId;
    return (
      <button
        key={item.id}
        onClick={item.onClick}
        onMouseEnter={() => setHovered(item.id)}
        onMouseLeave={() => setHovered(null)}
        aria-label={item.label}
        title={item.label}
        className={cn(
          "relative grid h-11 w-11 place-items-center rounded-xl transition-colors duration-200",
          isActive
            ? "text-white"
            : "text-white/45 hover:text-white/90 hover:bg-white/5"
        )}
      >
        {isActive && (
          <motion.span
            layoutId="sidebar-active"
            transition={{ type: "spring", stiffness: 420, damping: 34 }}
            className="absolute inset-0 rounded-xl bg-gradient-to-br from-brand/25 to-brand/5 ring-1 ring-brand/40"
          />
        )}
        <item.icon className="relative z-10 h-[19px] w-[19px]" strokeWidth={1.9} />
        {hovered === item.id && (
          <motion.span
            initial={{ opacity: 0, x: -4 }}
            animate={{ opacity: 1, x: 0 }}
            className="pointer-events-none absolute left-[52px] z-50 whitespace-nowrap rounded-md bg-ink-650 px-2 py-1 text-xs text-white/90 shadow-pop ring-1 ring-line"
          >
            {item.label}
          </motion.span>
        )}
      </button>
    );
  };

  return (
    <aside className="z-30 hidden h-full w-16 shrink-0 flex-col items-center gap-1 border-r border-line bg-ink-900 py-3 sm:flex">
      {topItems.map((item) =>
        renderItem({
          ...item,
          onClick: () => {
            setView("studio");
            setMode(item.mode);
          },
        })
      )}
      <span className="my-1 h-px w-6 bg-line" aria-hidden />
      {renderItem({
        id: "board",
        icon: Shapes,
        label: "Board",
        onClick: () => setView("canvas"),
      })}
    </aside>
  );
}
