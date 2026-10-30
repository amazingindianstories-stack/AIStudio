"use client";

import { ClipboardCopy, ClipboardPaste, Download, LayoutGrid, Repeat2, UserRound } from "lucide-react";
import { MenuItem } from "@/components/Dropdown";
import { useCanvasStore } from "@/lib/canvas-store";
import { displayName } from "@/lib/board-access";
import { canSwitchType, SWITCH_TYPES } from "@/lib/canvas/styles";
import {
  clusterSelection,
  copySelectionStyle,
  exportSelectedStickies,
  hasCopiedStyle,
  pasteSelectionStyle,
  setSelectedStickyFlag,
  switchSelectionType,
} from "@/lib/canvas/sticky-actions";
import { usePeople } from "@/lib/canvas/use-people";

const ICON = "h-4 w-4 text-white/45";
const SHORTCUT = "ml-auto text-xs text-white/40";

/** The More menu's style, type and sticky entries for the selected objects. */
export function StyleMoreItems({ nodes, readOnly, close }) {
  const people = usePeople();
  const boardName = useCanvasStore((s) => s.boardName);
  const personName = (id) => displayName(people.get(id), id);
  const stickies = nodes.filter((node) => node.type === "sticky");
  const switchable = nodes.length > 0 && nodes.every(canSwitchType);
  const types = new Set(nodes.map((node) => node.type));
  const run = (action) => () => {
    action();
    close();
  };
  const authorShown = stickies.length > 0 && stickies.every((node) => node.showAuthor);
  return (
    <>
      <div className="my-1 h-px bg-line" />
      <MenuItem onClick={run(copySelectionStyle)}>
        <ClipboardCopy className={ICON} /> Copy style
        <span className={SHORTCUT}>⌥⌘C</span>
      </MenuItem>
      {!readOnly && (
        <MenuItem disabled={!hasCopiedStyle()} onClick={run(pasteSelectionStyle)}>
          <ClipboardPaste className={ICON} /> Paste style
          <span className={SHORTCUT}>⌥⌘V</span>
        </MenuItem>
      )}
      {!readOnly && switchable && (
        <>
          <div className="my-1 h-px bg-line" />
          <p className="flex items-center gap-2.5 px-2.5 pb-0.5 pt-1 text-[11px] text-white/40">
            <Repeat2 className="h-3.5 w-3.5" /> Switch to
          </p>
          <div className="grid grid-cols-2 gap-0.5" role="group" aria-label="Switch to">
            {SWITCH_TYPES.filter((type) => !(types.size === 1 && types.has(type.id))).map((type) => (
              <MenuItem key={type.id} onClick={run(() => switchSelectionType(type.id))}>
                {type.name}
              </MenuItem>
            ))}
          </div>
        </>
      )}
      {stickies.length > 0 && (
        <>
          <div className="my-1 h-px bg-line" />
          {!readOnly && (
            <MenuItem onClick={run(() => setSelectedStickyFlag("showAuthor", !authorShown))}>
              <UserRound className={ICON} /> {authorShown ? "Hide author" : "Show author"}
            </MenuItem>
          )}
          <MenuItem onClick={run(() => exportSelectedStickies(personName, boardName))}>
            <Download className={ICON} /> Export {stickies.length === 1 ? "sticky" : `${stickies.length} stickies`} to CSV
          </MenuItem>
          {!readOnly && stickies.length > 1 && (
            <>
              <p className="flex items-center gap-2.5 px-2.5 pb-0.5 pt-1 text-[11px] text-white/40">
                <LayoutGrid className="h-3.5 w-3.5" /> Cluster stickies by
              </p>
              <div className="grid grid-cols-3 gap-0.5" role="group" aria-label="Cluster stickies by">
                <MenuItem onClick={run(() => clusterSelection("tag", personName))}>Tag</MenuItem>
                <MenuItem onClick={run(() => clusterSelection("color", personName))}>Color</MenuItem>
                <MenuItem onClick={run(() => clusterSelection("author", personName))}>Author</MenuItem>
              </div>
            </>
          )}
        </>
      )}
    </>
  );
}
