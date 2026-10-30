"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { useCanvasStore } from "@/lib/canvas-store";
import { useBoardUi } from "@/lib/canvas/board-ui";
import { useBoardPrefs } from "@/lib/canvas/board-prefs";
import { comboLabels, isMacPlatform, shortcutEntries } from "@/lib/canvas/shortcuts";
import { dockTools, toolLabel } from "@/lib/canvas/toolbar-tools";
import { readingOrder } from "@/lib/canvas/keyboard-nav";
import { organizeFrameEdits } from "@/lib/canvas/frames";
import { copySelection, copySelectionAsImage, startPresentation } from "./useBoardShortcuts";
import { copyObjectLink } from "./FramesPanel";

/** The shortcut shown beside a command, from the registry entry `id`. */
function hintFor(id, mac) {
  const entry = shortcutEntries().find((e) => e.id === id);
  return entry ? comboLabels(entry.keys[0], mac).join(mac ? "" : "+") : "";
}

/** Whether every word of `query` appears in `text`. */
export function commandMatches(text, query) {
  const haystack = text.toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((word) => haystack.includes(word));
}

/**
 * The command palette (Cmd+K): tools, board panels, recent boards and
 * actions on the selection, searchable by name and run with Enter.
 */
export function CommandPalette({ canEdit, boardId, runToolbarTool, openBoard, onClose }) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef(null);
  const listRef = useRef(null);
  const prefs = useBoardPrefs();
  const selection = useCanvasStore((s) => s.selection);
  const selectedConnectorIds = useCanvasStore((s) => s.selectedConnectorIds);
  const hasFrames = useCanvasStore((s) => s.history.present.nodes.some((n) => n.type === "frame"));
  const mac = isMacPlatform();

  useEffect(() => inputRef.current?.focus(), []);

  const commands = useMemo(() => {
    const ui = useBoardUi.getState();
    const store = () => useCanvasStore.getState();
    const list = [];
    const add = (section, id, label, run, hint = "") => list.push({ section, id, label, run, hint });

    for (const tool of dockTools(prefs, canEdit)) {
      add("Tools", `tool.${tool}`, toolLabel(tool), () => runToolbarTool(tool), hintFor(`tool.${tool}`, mac));
    }

    add("Board", "find", "Find on board", () => ui.setFindOpen(true), hintFor("board.find", mac));
    add("Board", "frames", "Frames", () => ui.togglePanel("frames"));
    if (hasFrames) add("Board", "present", "Present frames", startPresentation, hintFor("board.present", mac));
    add("Board", "outline", "Explore board content", () => ui.togglePanel("outline"));
    add("Board", "a11y", "Check accessibility", () => ui.togglePanel("a11y"));
    add("Board", "shortcuts", "Keyboard shortcuts", () => ui.setShortcutsOpen(true), hintFor("board.help", mac));
    add("Board", "fit", "Zoom to fit", () => store().zoomToFit(), hintFor("view.fit", mac));
    add("Board", "selectAll", "Select all", () => store().selectAll(), hintFor("nav.all", mac));
    if (canEdit && hasFrames) {
      add("Board", "organize", "Organize frames", () => {
        store().replaceNodes(organizeFrameEdits(store().history.present));
        store().zoomToFit();
      });
    }
    add(
      "Board",
      "singleKeys",
      prefs.singleKeyShortcuts ? "Turn off single-key shortcuts" : "Turn on single-key shortcuts",
      () => useBoardPrefs.getState().setPrefs({ singleKeyShortcuts: !prefs.singleKeyShortcuts })
    );

    const one = selection.length === 1 ? selection[0] : selectedConnectorIds.length === 1 && !selection.length ? selectedConnectorIds[0] : null;
    add("Selection", "link", one ? "Copy link to selected object" : "Copy link to board", () => void copyObjectLink(one ?? undefined));
    if (selection.length) {
      add("Selection", "copyText", "Copy as text", () => void copySelection(), hintFor("edit.copy", mac));
      add("Selection", "copyImage", "Copy as image", () => void copySelectionAsImage(), hintFor("edit.copyImage", mac));
    }
    if (canEdit && selection.length >= 2) {
      add("Selection", "connect", `Connect ${selection.length} selected objects with arrows`, () => {
        const present = store().history.present;
        const chosen = new Set(selection);
        const order = readingOrder(present.nodes.filter((n) => chosen.has(n.id)));
        store().connectNodes(order.slice(1).map((id, i) => [order[i], id]), "arrow");
      });
    }
    if (canEdit) {
      add("Selection", "undo", "Undo", () => store().undo(), hintFor("edit.undo", mac));
      add("Selection", "redo", "Redo", () => store().redo(), hintFor("edit.redo", mac));
    }

    for (const board of prefs.recentBoards) {
      if (board.id === boardId) continue;
      add("Recent boards", `board.${board.id}`, board.name || "Untitled board", () => openBoard({ project: board.projectId, board: board.id }));
    }
    return list;
  }, [prefs, canEdit, hasFrames, selection, selectedConnectorIds, boardId, runToolbarTool, openBoard, mac]);

  const shown = useMemo(() => (query ? commands.filter((c) => commandMatches(`${c.section} ${c.label}`, query)) : commands), [commands, query]);
  const at = shown.length ? Math.min(active, shown.length - 1) : -1;

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [at]);

  const run = (command) => {
    onClose({ refocus: false });
    command.run();
    // Most commands act on the board, so keyboard focus returns there,
    // unless the command opened something that took focus itself.
    requestAnimationFrame(() => {
      if (document.activeElement === document.body) document.querySelector("[data-board-surface]")?.focus();
    });
  };

  const onKeyDown = (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (shown.length) setActive((at + (e.key === "ArrowDown" ? 1 : -1) + shown.length) % shown.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (at >= 0) run(shown[at]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose({ refocus: true });
    }
  };

  let lastSection = null;
  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-start justify-center bg-black/50 px-4 pt-[12vh]" onPointerDown={(e) => e.target === e.currentTarget && onClose({ refocus: true })}>
      <div role="dialog" aria-modal="true" aria-label="Command palette" className="w-full max-w-lg overflow-hidden rounded-2xl border border-line bg-ink-750 shadow-pop" onKeyDown={onKeyDown}>
        <label className="flex items-center gap-2.5 border-b border-line px-4 py-3">
          <Search className="h-4 w-4 shrink-0 text-white/40" aria-hidden />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search commands, tools and boards"
            aria-label="Search commands"
            role="combobox"
            aria-expanded="true"
            aria-controls="command-palette-list"
            aria-activedescendant={at >= 0 ? `command-${shown[at].id}` : undefined}
            className="min-w-0 flex-1 bg-transparent text-sm text-white placeholder:text-white/35 outline-none"
          />
        </label>
        <ul ref={listRef} id="command-palette-list" role="listbox" aria-label="Commands" className="max-h-[min(420px,60vh)] overflow-y-auto p-1.5">
          {!shown.length && <li className="px-3 py-6 text-center text-sm text-white/50">No matching commands</li>}
          {shown.map((command, i) => {
            const heading = command.section !== lastSection ? command.section : null;
            lastSection = command.section;
            return (
              <li key={command.id} role="presentation">
                {heading && <div className="px-2.5 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-white/40">{heading}</div>}
                <div
                  id={`command-${command.id}`}
                  role="option"
                  aria-selected={i === at}
                  onPointerMove={() => setActive(i)}
                  onClick={() => run(command)}
                  className={cn("flex cursor-pointer items-center justify-between gap-3 rounded-lg px-2.5 py-2 text-sm", i === at ? "bg-white/[0.09] text-white" : "text-white/75")}
                >
                  <span className="truncate">{command.label}</span>
                  {command.hint && <kbd className="shrink-0 font-sans text-xs text-white/40">{command.hint}</kbd>}
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </div>,
    document.body
  );
}
