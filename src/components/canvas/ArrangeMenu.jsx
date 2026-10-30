"use client";

import { useState } from "react";
import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignHorizontalDistributeCenter,
  AlignStartHorizontal,
  AlignStartVertical,
  AlignVerticalDistributeCenter,
  ChevronDown,
  ChevronRight,
  Eraser,
  ListFilter,
} from "lucide-react";
import { Dropdown, MenuItem } from "@/components/Dropdown";
import { useCanvasStore, selectReadOnly } from "@/lib/canvas-store";
import { arrangeUnits, holdsText, selectionKinds } from "@/lib/canvas/arrange";
import { lockedIdSet } from "@/lib/canvas/locks";
import { cn } from "@/lib/utils";

const ALIGN_ITEMS = [
  { mode: "left", label: "Align left", Icon: AlignStartVertical },
  { mode: "hcenter", label: "Align center", Icon: AlignCenterVertical },
  { mode: "right", label: "Align right", Icon: AlignEndVertical },
  { mode: "top", label: "Align top", Icon: AlignStartHorizontal },
  { mode: "vcenter", label: "Align middle", Icon: AlignCenterHorizontal },
  { mode: "bottom", label: "Align bottom", Icon: AlignEndHorizontal },
];

const DISTRIBUTE_ITEMS = [
  { axis: "x", label: "Distribute horizontally", Icon: AlignHorizontalDistributeCenter },
  { axis: "y", label: "Distribute vertically", Icon: AlignVerticalDistributeCenter },
];

const ICON = "h-4 w-4 text-white/50";

/**
 * Runs an arrange action named by a menu: "align:<mode>", "distribute:x|y",
 * "filter:<kind>" or "clearContent". Unknown names do nothing.
 */
export function runArrangeMenuAction(action) {
  if (typeof action !== "string") return;
  const s = useCanvasStore.getState();
  const [name, arg] = action.split(":");
  if (name === "align") s.alignSelection(arg);
  else if (name === "distribute") s.distributeSelection(arg);
  else if (name === "filter") s.filterSelectionByKind(arg);
  else if (name === "clearContent") s.clearSelectedContent();
}

/** Which arrange commands the current selection offers. */
export function useArrangeOptions() {
  const present = useCanvasStore((s) => s.history.present);
  const selection = useCanvasStore((s) => s.selection);
  const readOnly = useCanvasStore(selectReadOnly);
  const units = selection.length > 1 ? arrangeUnits(present, selection).length : 0;
  const kinds = selection.length > 1 ? selectionKinds(present, selection) : [];
  const wanted = new Set(selection);
  const locked = lockedIdSet(present);
  const canClear =
    !readOnly && present.nodes.some((n) => wanted.has(n.id) && !locked.has(n.id) && holdsText(n) && (n.text || n.marks));
  return {
    canAlign: !readOnly && units >= 2,
    canDistribute: !readOnly && units >= 3,
    kinds: kinds.length > 1 ? kinds : [],
    canClear,
  };
}

function Section({ label, Icon, children }) {
  const [open, setOpen] = useState(false);
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <>
      <MenuItem onClick={() => setOpen((v) => !v)} label={`${label}${open ? ", expanded" : ""}`}>
        <Icon className={ICON} />
        <span className="flex-1">{label}</span>
        <Chevron className="ml-auto h-3.5 w-3.5 text-white/40" />
      </MenuItem>
      {open && <div className="ml-3 border-l border-line pl-1">{children}</div>}
    </>
  );
}

/**
 * The context menu's arrange rows: Align and Distribute (2+ and 3+ movable
 * objects), Filter selection (2+ object types) and Clear content. Each row
 * reports its action name through `onAction`, which runs it and closes.
 */
export function ArrangeMenuItems({ onAction }) {
  const { canAlign, canDistribute, kinds, canClear } = useArrangeOptions();
  if (!canAlign && !kinds.length && !canClear) return null;
  return (
    <>
      <div className="my-1 h-px bg-line" />
      {canAlign && (
        <Section label="Align" Icon={AlignStartVertical}>
          {ALIGN_ITEMS.map(({ mode, label, Icon }) => (
            <MenuItem key={mode} onClick={() => onAction(`align:${mode}`)}>
              <Icon className={ICON} />
              <span className="flex-1">{label}</span>
            </MenuItem>
          ))}
          {canDistribute &&
            DISTRIBUTE_ITEMS.map(({ axis, label, Icon }) => (
              <MenuItem key={axis} onClick={() => onAction(`distribute:${axis}`)}>
                <Icon className={ICON} />
                <span className="flex-1">{label}</span>
              </MenuItem>
            ))}
        </Section>
      )}
      {kinds.length > 0 && (
        <Section label="Filter selection" Icon={ListFilter}>
          <FilterRows kinds={kinds} onPick={(kind) => onAction(`filter:${kind}`)} />
        </Section>
      )}
      {canClear && (
        <MenuItem onClick={() => onAction("clearContent")}>
          <Eraser className={ICON} />
          <span className="flex-1">Clear content</span>
          <span className="ml-auto pl-6 text-xs text-white/40">⌘⌫</span>
        </MenuItem>
      )}
    </>
  );
}

function FilterRows({ kinds, onPick }) {
  return kinds.map(({ kind, label, count }) => (
    <MenuItem key={kind} onClick={() => onPick(kind)} label={`${label}, ${count}`}>
      <span className="flex-1">{label}</span>
      <span className="ml-auto pl-6 text-xs tabular-nums text-white/40">{count}</span>
    </MenuItem>
  ));
}

function ToolbarTrigger({ open, label, Icon }) {
  return (
    <span
      className={cn(
        "grid h-8 w-8 cursor-pointer place-items-center rounded-lg text-white/60 transition hover:bg-white/[0.08] hover:text-white",
        open && "bg-white/[0.08] text-white"
      )}
      title={label}
    >
      <Icon className="h-4 w-4" />
    </span>
  );
}

/** The selection toolbar's Align and Filter buttons, shown when they apply. */
export function ArrangeControls() {
  const { canAlign, canDistribute, kinds } = useArrangeOptions();
  const run = (action, close) => {
    runArrangeMenuAction(action);
    close();
  };
  return (
    <>
      {canAlign && (
        <Dropdown label="Align" trigger={(open) => <ToolbarTrigger open={open} label="Align" Icon={AlignStartVertical} />}>
          {(close) => (
            <>
              {ALIGN_ITEMS.map(({ mode, label, Icon }) => (
                <MenuItem key={mode} onClick={() => run(`align:${mode}`, close)}>
                  <Icon className={ICON} />
                  <span className="flex-1">{label}</span>
                </MenuItem>
              ))}
              <div className="my-1 h-px bg-line" />
              {DISTRIBUTE_ITEMS.map(({ axis, label, Icon }) => (
                <MenuItem
                  key={axis}
                  disabled={!canDistribute}
                  title={canDistribute ? undefined : "Select at least 3 objects"}
                  onClick={() => run(`distribute:${axis}`, close)}
                >
                  <Icon className={ICON} />
                  <span className="flex-1">{label}</span>
                </MenuItem>
              ))}
            </>
          )}
        </Dropdown>
      )}
      {kinds.length > 0 && (
        <Dropdown label="Filter selection" trigger={(open) => <ToolbarTrigger open={open} label="Filter selection" Icon={ListFilter} />}>
          {(close) => <FilterRows kinds={kinds} onPick={(kind) => run(`filter:${kind}`, close)} />}
        </Dropdown>
      )}
    </>
  );
}
