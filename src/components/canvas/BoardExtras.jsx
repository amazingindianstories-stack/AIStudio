"use client";

import { useEffect, useRef, useState } from "react";
import { Accessibility, ChevronDown, Command, Keyboard, ListTree, Play, Rows3, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { useCanvasStore } from "@/lib/canvas-store";
import { useBoardUi } from "@/lib/canvas/board-ui";
import { edgeStop } from "@/lib/canvas/keyboard-nav";
import { comboLabels, isMacPlatform, shortcutEntries } from "@/lib/canvas/shortcuts";
import { BoardFind, BoardFindOverlay } from "./BoardFind";
import { FramesPanel } from "./FramesPanel";
import { BoardOutline } from "./BoardOutline";
import { AccessibilityPanel } from "./AccessibilityPanel";
import { BoardPresentation, stopPresentation } from "./BoardPresentation";
import { CommandPalette } from "./CommandPalette";
import { ShortcutsPanel } from "./ShortcutsPanel";
import { BoardStatus } from "./BoardStatus";
import { selectFromKeyboard, startPresentation } from "./useBoardShortcuts";

function focusBoardSurface() {
  document.querySelector("[data-board-surface]")?.focus();
}

/**
 * The board's find, panels, presentation, palette and shortcut reference,
 * driven by the board UI store. Mounted once by the board view.
 */
export function BoardExtras({ boardId, loaded, canEdit, runToolbarTool, openBoard, rootRef }) {
  const ui = useBoardUi();

  // A different board (or leaving the board view) closes all of it.
  useEffect(() => {
    useBoardUi.getState().reset();
    return () => {
      stopPresentation();
      useBoardUi.getState().reset();
    };
  }, [boardId]);

  const closeFind = () => {
    ui.setFindOpen(false);
    focusBoardSurface();
  };
  const closePanel = () => {
    ui.closePanel();
    focusBoardSurface();
  };

  if (!boardId || !loaded) return <BoardStatus />;
  return (
    <>
      <BoardFindOverlay />
      {ui.findOpen && !ui.presenting && <BoardFind canEdit={canEdit} onClose={closeFind} />}
      {ui.panel === "frames" && <FramesPanel canEdit={canEdit} onClose={closePanel} />}
      {ui.panel === "outline" && <BoardOutline onClose={closePanel} />}
      {ui.panel === "a11y" && <AccessibilityPanel canEdit={canEdit} onClose={closePanel} />}
      {ui.presenting && <BoardPresentation rootRef={rootRef} />}
      {ui.paletteOpen && (
        <CommandPalette
          canEdit={canEdit}
          boardId={boardId}
          runToolbarTool={runToolbarTool}
          openBoard={openBoard}
          onClose={({ refocus }) => {
            ui.setPaletteOpen(false);
            if (refocus) focusBoardSurface();
          }}
        />
      )}
      {ui.shortcutsOpen && (
        <ShortcutsPanel
          onClose={() => {
            ui.setShortcutsOpen(false);
            focusBoardSurface();
          }}
        />
      )}
      <BoardStatus />
    </>
  );
}

/** A link for keyboard users, shown on focus: selects the first object in reading order. */
export function BoardSkipLink() {
  return (
    <a
      href="#board"
      onClick={(e) => {
        e.preventDefault();
        const store = useCanvasStore.getState();
        const first = edgeStop(store.history.present, [], "first");
        focusBoardSurface();
        if (first) selectFromKeyboard(first);
        else useBoardUi.getState().announce("The board is empty.");
      }}
      className="sr-only left-4 top-4 z-[80] rounded-lg bg-brand px-3 py-2 text-sm font-semibold text-ink-900 focus:not-sr-only focus:absolute"
    >
      Skip to first object
    </a>
  );
}

function hint(id, mac) {
  const entry = shortcutEntries().find((e) => e.id === id);
  return entry ? comboLabels(entry.keys[0], mac).join(mac ? "" : "+") : "";
}

/** The "Board" menu in the top bar: find, frames, presenting, content outline, checks and help. */
export function BoardMenu() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const buttonRef = useRef(null);
  const mac = isMacPlatform();
  const hasFrames = useCanvasStore((s) => s.history.present.nodes.some((n) => n.type === "frame"));
  const panel = useBoardUi((s) => s.panel);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (!rootRef.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    rootRef.current?.querySelector('[role="menuitem"], [role="menuitemcheckbox"]')?.focus();
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  const ui = useBoardUi.getState;
  const items = [
    { id: "find", label: "Find on board", Icon: Search, hint: hint("board.find", mac), run: () => ui().setFindOpen(true) },
    { id: "frames", label: "Frames", Icon: Rows3, checked: panel === "frames", run: () => ui().togglePanel("frames") },
    { id: "present", label: "Present frames", Icon: Play, hint: hint("board.present", mac), disabled: !hasFrames, run: startPresentation },
    { id: "outline", label: "Explore board content", Icon: ListTree, checked: panel === "outline", run: () => ui().togglePanel("outline") },
    { id: "a11y", label: "Check accessibility", Icon: Accessibility, checked: panel === "a11y", run: () => ui().togglePanel("a11y") },
    { id: "palette", label: "Command palette", Icon: Command, hint: hint("board.palette", mac), run: () => ui().setPaletteOpen(true) },
    { id: "shortcuts", label: "Keyboard shortcuts", Icon: Keyboard, hint: hint("board.help", mac), run: () => ui().setShortcutsOpen(true) },
  ];

  const onMenuKeyDown = (e) => {
    const all = [...rootRef.current.querySelectorAll('[role="menuitem"]:not([disabled]), [role="menuitemcheckbox"]')];
    const at = all.indexOf(document.activeElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      all[(at + (e.key === "ArrowDown" ? 1 : -1) + all.length) % all.length]?.focus();
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      all[e.key === "Home" ? 0 : all.length - 1]?.focus();
    } else if (e.key === "Escape" || e.key === "Tab") {
      if (e.key === "Escape") e.preventDefault();
      setOpen(false);
      if (e.key === "Escape") buttonRef.current?.focus();
    }
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex items-center gap-1.5 rounded-full border border-line bg-ink-700 px-3 py-1.5 text-sm text-white/85 outline-none transition hover:text-white focus-visible:ring-2 focus-visible:ring-brand",
          open && "bg-ink-600 text-white"
        )}
      >
        Board
        <ChevronDown className="h-3.5 w-3.5" />
      </button>
      {open && (
        <div
          role="menu"
          aria-label="Board"
          data-board-keys="own"
          onKeyDown={onMenuKeyDown}
          className="absolute left-0 top-full z-50 mt-2 w-64 rounded-xl border border-line bg-ink-750/95 p-1 shadow-pop backdrop-blur-xl"
        >
          {items.map(({ id, label, Icon, hint: keys, run, disabled, checked }) => (
            <button
              key={id}
              type="button"
              role={checked === undefined ? "menuitem" : "menuitemcheckbox"}
              aria-checked={checked === undefined ? undefined : checked}
              disabled={disabled}
              onClick={() => {
                setOpen(false);
                run();
              }}
              className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm text-white/80 outline-none hover:bg-white/[0.07] hover:text-white focus-visible:bg-white/[0.07] focus-visible:text-white disabled:pointer-events-none disabled:opacity-40"
            >
              <Icon className="h-4 w-4 shrink-0 text-white/50" aria-hidden />
              <span className="flex-1">{label}</span>
              {keys && <kbd className="font-sans text-xs text-white/40">{keys}</kbd>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
