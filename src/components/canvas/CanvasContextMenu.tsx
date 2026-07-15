"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion } from "framer-motion";
import {
  CopyPlus,
  Copy,
  ClipboardPaste,
  BringToFront,
  SendToBack,
  Group,
  Ungroup,
  Trash2,
} from "lucide-react";
import { MenuItem } from "@/components/Dropdown";
import type { SelectionActionFlags } from "@/lib/canvas/selection-actions";

export type ContextMenuAction =
  | "duplicate"
  | "copy"
  | "paste"
  | "delete"
  | "bringToFront"
  | "sendToBack"
  | "group"
  | "ungroup";

const MARGIN = 8;

/**
 * Cursor-anchored right-click menu (ui-spec §B). Positioning is genuinely
 * new plumbing (a `Dropdown` is trigger-anchored, not cursor-anchored — see
 * decisions.md's "Trade-offs"), but the panel/row styling is a deliberate
 * visual clone of `Dropdown`'s panel + `MenuItem`, reused verbatim.
 */
export function CanvasContextMenu({
  x,
  y,
  flags,
  onAction,
  onClose,
}: {
  x: number; // client (screen) coords
  y: number;
  flags: SelectionActionFlags;
  onAction: (action: ContextMenuAction) => void;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  // Outside-click / Escape / scroll dismissal — mirrors Dropdown.tsx:47-68.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) onClose();
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onScroll = () => onClose();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onEsc);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onEsc);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [onClose]);

  // Clamp into the viewport (flip left/up near the bottom/right edges) —
  // same margin=8 idea as Dropdown.tsx:78-94's place(), simplified for a
  // cursor point instead of a trigger rect.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const place = () => {
      const rect = panel.getBoundingClientRect();
      const width = Math.min(rect.width, window.innerWidth - MARGIN * 2);
      const height = Math.min(rect.height, window.innerHeight - MARGIN * 2);
      let left = x;
      let top = y;
      if (left + width > window.innerWidth - MARGIN) left = Math.max(MARGIN, x - width);
      if (top + height > window.innerHeight - MARGIN) top = Math.max(MARGIN, y - height);
      setPosition({ left, top });
    };
    const frame = requestAnimationFrame(place);
    return () => cancelAnimationFrame(frame);
  }, [x, y]);

  // Move focus to the first (enabled) row on open — keyboard-operable menu.
  useEffect(() => {
    const first = panelRef.current?.querySelector<HTMLButtonElement>(
      '[role="menuitem"]:not(:disabled)'
    );
    first?.focus();
  }, []);

  const nodeTarget = flags.hasNodeSelection;
  const connectorOnly = flags.hasConnectorSelection && !flags.hasNodeSelection;
  const showGroupBlock = flags.canGroup || flags.canUngroup;

  return createPortal(
    <motion.div
      ref={panelRef}
      role="menu"
      initial={{ opacity: 0, y: -6, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ type: "spring", stiffness: 480, damping: 32 }}
      style={{
        left: position?.left ?? x,
        top: position?.top ?? y,
        visibility: position ? "visible" : "hidden",
      }}
      className="scroll-thin fixed z-[100] min-w-[170px] max-w-[calc(100vw-1rem)] overflow-y-auto rounded-xl border border-line bg-ink-750/95 p-1.5 shadow-pop backdrop-blur-xl"
    >
      {connectorOnly ? (
        <DeleteRow onAction={onAction} />
      ) : !nodeTarget ? (
        <MenuItem disabled={!flags.canPaste} onClick={() => onAction("paste")}>
          <ClipboardPaste className="h-4 w-4 text-white/50" />
          <span className="flex-1">Paste</span>
          <span className="ml-auto pl-6 text-xs text-white/40">⌘V</span>
        </MenuItem>
      ) : (
        <>
          <MenuItem onClick={() => onAction("duplicate")}>
            <CopyPlus className="h-4 w-4 text-white/50" />
            <span className="flex-1">Duplicate</span>
            <span className="ml-auto pl-6 text-xs text-white/40">⌘D</span>
          </MenuItem>
          <MenuItem onClick={() => onAction("copy")}>
            <Copy className="h-4 w-4 text-white/50" />
            <span className="flex-1">Copy</span>
            <span className="ml-auto pl-6 text-xs text-white/40">⌘C</span>
          </MenuItem>
          <MenuItem disabled={!flags.canPaste} onClick={() => onAction("paste")}>
            <ClipboardPaste className="h-4 w-4 text-white/50" />
            <span className="flex-1">Paste</span>
            <span className="ml-auto pl-6 text-xs text-white/40">⌘V</span>
          </MenuItem>

          <div className="my-1 h-px bg-line" />

          <MenuItem onClick={() => onAction("bringToFront")}>
            <BringToFront className="h-4 w-4 text-white/50" />
            <span className="flex-1">Bring to Front</span>
            <span className="ml-auto pl-6 text-xs text-white/40">⌘⇧]</span>
          </MenuItem>
          <MenuItem onClick={() => onAction("sendToBack")}>
            <SendToBack className="h-4 w-4 text-white/50" />
            <span className="flex-1">Send to Back</span>
            <span className="ml-auto pl-6 text-xs text-white/40">⌘⇧[</span>
          </MenuItem>

          {showGroupBlock && <div className="my-1 h-px bg-line" />}
          {flags.canGroup && (
            <MenuItem onClick={() => onAction("group")}>
              <Group className="h-4 w-4 text-white/50" />
              <span className="flex-1">Group</span>
              <span className="ml-auto pl-6 text-xs text-white/40">⌘G</span>
            </MenuItem>
          )}
          {flags.canUngroup && (
            <MenuItem onClick={() => onAction("ungroup")}>
              <Ungroup className="h-4 w-4 text-white/50" />
              <span className="flex-1">Ungroup</span>
              <span className="ml-auto pl-6 text-xs text-white/40">⌘⇧G</span>
            </MenuItem>
          )}

          <div className="my-1 h-px bg-line" />

          <DeleteRow onAction={onAction} />
        </>
      )}
    </motion.div>,
    document.body
  );
}

function DeleteRow({ onAction }: { onAction: (action: ContextMenuAction) => void }) {
  return (
    <MenuItem onClick={() => onAction("delete")}>
      <Trash2 className="h-4 w-4 text-red-400/80" />
      <span className="flex-1 text-red-300/90">Delete</span>
      <span className="ml-auto pl-6 text-xs text-white/40">⌦</span>
    </MenuItem>
  );
}
