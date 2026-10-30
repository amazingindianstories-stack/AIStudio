"use client";

import { Check, Maximize, Minimize, SlidersHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";
import { Dropdown, MenuItem } from "@/components/Dropdown";
import { canShareRole } from "@/lib/board-access";
import { selectReadOnly, useCanvasStore } from "@/lib/canvas-store";
import { BOARD_BACKGROUNDS, boardBackgroundColor } from "@/lib/canvas/board-view";
import { useViewPrefs } from "@/lib/canvas/view-prefs";
import { toggleFullscreen, useFullscreen } from "./use-board-fullscreen";

const GRID_CHOICES = [
  { value: "dots", label: "Dots" },
  { value: "lines", label: "Lines" },
  { value: "none", label: "None" },
];

const NAVIGATION_CHOICES = [
  { value: "auto", label: "Auto" },
  { value: "mouse", label: "Mouse" },
  { value: "trackpad", label: "Trackpad" },
];

// Personal on/off preferences, in menu order.
const TOGGLES = [
  { key: "snapToGrid", label: "Snap to grid" },
  { key: "alignmentGuides", label: "Alignment guides" },
  { key: "preciseSelection", label: "Precise selection" },
  { key: "showDimensions", label: "Object dimensions" },
  { key: "minimap", label: "Minimap", shortcut: "M" },
  { key: "scrollbars", label: "Scroll bars" },
  { key: "reduceMotion", label: "Reduce motion" },
];

/**
 * The View menu beside the zoom control: this person's view preferences
 * (grid, overlays, navigation, motion), full screen, and the board-wide
 * background and start view for the people allowed to change them.
 */
export function ViewMenu() {
  const prefs = useViewPrefs();
  const fullscreen = useFullscreen();
  const readOnly = useCanvasStore(selectReadOnly);
  const boardRole = useCanvasStore((s) => s.boardRole);
  const settings = useCanvasStore((s) => s.history.present.settings);
  const canSetStartView = !readOnly && canShareRole(boardRole);
  const background = boardBackgroundColor(settings);

  return (
    <Dropdown
      label="View options"
      side="top"
      align="right"
      panelClassName="w-64"
      trigger={(open) => (
        <span
          title="View"
          className={cn(
            "grid h-7 w-7 place-items-center rounded-md text-white/55 transition hover:bg-white/[0.07] hover:text-white",
            open && "bg-white/[0.07] text-white"
          )}
        >
          <SlidersHorizontal className="h-3.5 w-3.5" />
        </span>
      )}
    >
      {(close) => (
        <>
          <SectionLabel hint="G">Grid</SectionLabel>
          <Segmented choices={GRID_CHOICES} value={prefs.grid} onChange={(value) => prefs.setPref("grid", value)} />

          <Separator />
          {TOGGLES.map(({ key, label, shortcut }) => (
            <MenuItem key={key} role="menuitemcheckbox" checked={prefs[key]} onClick={() => prefs.togglePref(key)}>
              <CheckMark on={prefs[key]} />
              <span className="flex-1">{label}</span>
              {shortcut && <span className="text-xs text-white/40">{shortcut}</span>}
            </MenuItem>
          ))}

          <Separator />
          <SectionLabel>Wheel and trackpad</SectionLabel>
          <Segmented
            choices={NAVIGATION_CHOICES}
            value={prefs.navigationMode}
            onChange={(value) => prefs.setPref("navigationMode", value)}
          />

          <Separator />
          <MenuItem
            onClick={() => {
              close({ restoreFocus: false });
              void toggleFullscreen();
            }}
          >
            {fullscreen ? <Minimize className="h-4 w-4 text-white/45" /> : <Maximize className="h-4 w-4 text-white/45" />}
            <span className="flex-1">{fullscreen ? "Exit full screen" : "Full screen"}</span>
          </MenuItem>

          {!readOnly && (
            <>
              <Separator />
              <SectionLabel>Board background</SectionLabel>
              <div className="grid grid-cols-6 gap-1.5 px-2.5 pb-2 pt-1" role="group" aria-label="Board background">
                {BOARD_BACKGROUNDS.map((choice) => {
                  const on = choice.color === background;
                  return (
                    <button
                      key={choice.name}
                      type="button"
                      role="menuitemradio"
                      aria-checked={on}
                      aria-label={`${choice.name} background`}
                      title={choice.name}
                      onClick={() => useCanvasStore.getState().setBoardBackground(choice.value)}
                      className={cn(
                        "grid h-7 w-7 place-items-center rounded-md ring-1 ring-inset ring-white/15 outline-none transition focus-visible:ring-2 focus-visible:ring-brand",
                        on ? "ring-2 ring-white/80" : "hover:ring-white/40"
                      )}
                      style={{ backgroundColor: choice.color }}
                    >
                      {on && <Check className="h-3.5 w-3.5 text-white/85" />}
                    </button>
                  );
                })}
              </div>
            </>
          )}

          {canSetStartView && (
            <>
              <Separator />
              <SectionLabel>Start view for new members</SectionLabel>
              <MenuItem
                onClick={() => {
                  useCanvasStore.getState().setStartView();
                  close();
                }}
              >
                <span className="w-4" />
                <span className="flex-1">Set current view as start view</span>
              </MenuItem>
              <MenuItem
                disabled={!settings?.startView}
                onClick={() => {
                  useCanvasStore.getState().clearStartView();
                  close();
                }}
              >
                <span className="w-4" />
                <span className="flex-1">Clear start view</span>
              </MenuItem>
            </>
          )}
        </>
      )}
    </Dropdown>
  );
}

function SectionLabel({ children, hint }) {
  return (
    <div className="flex items-center px-2.5 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-wide text-white/40">
      <span className="flex-1">{children}</span>
      {hint && <span className="normal-case tracking-normal">{hint}</span>}
    </div>
  );
}

function Separator() {
  return <div className="mx-1 my-1 h-px bg-line" role="separator" />;
}

function CheckMark({ on }) {
  return <Check className={cn("h-4 w-4", on ? "text-white/80" : "text-transparent")} aria-hidden />;
}

function Segmented({ choices, value, onChange }) {
  return (
    <div className="grid grid-flow-col gap-1 px-1 pb-1" style={{ gridAutoColumns: "1fr" }}>
      {choices.map((choice) => (
        <button
          key={choice.value}
          type="button"
          role="menuitemradio"
          aria-checked={value === choice.value}
          onClick={() => onChange(choice.value)}
          className={cn(
            "rounded-lg px-2 py-1.5 text-center text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-brand",
            value === choice.value ? "bg-white/[0.1] text-white" : "text-white/60 hover:bg-white/6 hover:text-white"
          )}
        >
          {choice.label}
        </button>
      ))}
    </div>
  );
}
