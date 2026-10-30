"use client";

import { Fragment, useEffect, useState } from "react";
import { motion } from "framer-motion";
import {
  MousePointer2,
  Hand,
  StickyNote,
  Type,
  MoveRight,
  Frame,
  Spline,
  ImagePlus,
  ChevronDown,
  Minus,
  Plus,
  ZoomIn,
  ZoomOut,
  Sparkles,
  Undo2,
  Redo2,
  SlidersHorizontal,
  ArrowUp,
  ArrowDown,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useCanvasStore, } from "@/lib/canvas-store";
import { nodeBounds } from "@/lib/canvas/geometry";
import { Dropdown, MenuItem } from "@/components/Dropdown";
import { BASIC_SHAPES, isShapeTool } from "@/lib/canvas/shapes";
import { ShapeGlyph } from "./ShapeGlyph";
import { ACTIVE_STATUSES, useBoardAi } from "@/lib/board-ai";
import { useBoardPrefs } from "@/lib/canvas/board-prefs";
import { CREATION_TOOLS, moveTool, orderedTools, pinnedTools, placeToolBefore, togglePinned, toolLabel } from "@/lib/canvas/toolbar-tools";

/**
 * Bottom-center floating tool dock (ui-spec §3) + bottom-right zoom control
 * (§2). Both are separate floating layers per the ui-spec's layer diagram;
 * they're implemented from this one file since the file plan has no
 * dedicated component for the zoom control.
 */
export function CanvasToolbar({
  readOnly = false,
  /** Touch view-only mode: the board pans and zooms but shows no creation tools. */
  viewOnly = false,
  /** Width of the asset panel column on the left; the dock centres on the canvas beside it. */
  insetLeft = 0,
  toolLocked,
  shapesOpen,
  onShapesOpenChange,
  onToggleLock,
  onAddImageClick,
  aiOpen,
  onAiClick,
}

) {
  const tool = useCanvasStore((s) => s.tool);
  const aiRunning = useBoardAi((s) => Boolean(s.job && ACTIVE_STATUSES.includes(s.job.status)));
  const setTool = useCanvasStore((s) => s.setTool);
  const [lastShape, setLastShape] = useState("rect");

  const prefs = useBoardPrefs();
  useEffect(() => useBoardPrefs.getState().hydrate(), []);
  const canUndo = useCanvasStore((s) => s.history.past.length > 0);
  const canRedo = useCanvasStore((s) => s.history.future.length > 0);
  const undo = useCanvasStore((s) => s.undo);
  const redo = useCanvasStore((s) => s.redo);

  const shapeToolActive = isShapeTool(tool);
  const shapeButtonTool = shapeToolActive ? tool : lastShape;

  const arm = (id, e) => {
    setTool(id);
    if (e?.detail === 2) onToggleLock();
  };

  // Each creation tool's dock button, in the order the person arranged them.
  const renderCreationTool = (id) => {
    switch (id) {
      case "sticky":
        return (
          <ToolButton
            id="sticky"
            active={tool === "sticky"}
            icon={StickyNote}
            label="Sticky note"
            shortcut="N"
            locked={toolLocked && tool === "sticky"}
            onClick={(e) => arm("sticky", e)}
          />
        );
      case "text":
        return (
          <ToolButton
            id="text"
            active={tool === "text"}
            icon={Type}
            label="Text"
            shortcut="T"
            locked={toolLocked && tool === "text"}
            onClick={(e) => arm("text", e)}
          />
        );
      case "shapes":
        return (
          <Dropdown
            side="top"
            label="Shapes"
            open={shapesOpen}
            onOpenChange={onShapesOpenChange}
            panelClassName="min-w-0"
            trigger={(open) => (
              <span
                className={cn(
                  "relative grid h-9 w-9 place-items-center rounded-lg transition-colors max-sm:h-8 max-sm:w-8",
                  shapeToolActive
                    ? "bg-ink-600 ring-1 ring-line text-white"
                    : "text-white/55 hover:bg-white/[0.07] hover:text-white",
                  open && "bg-white/[0.07]"
                )}
                title="Shapes (S)"
              >
                <ShapeGlyph tool={shapeButtonTool} className="h-[18px] w-[18px]" />
                {toolLocked && shapeToolActive && (
                  <span className="absolute bottom-0.5 right-0.5 h-1.5 w-1.5 rounded-full bg-brand" />
                )}
              </span>
            )}
          >
            {(close) => (
              <div className="w-[212px] p-0.5">
                <p className="px-1.5 pb-1.5 pt-0.5 text-[11px] font-medium uppercase tracking-wide text-white/40">Basic shapes</p>
                <div role="group" aria-label="Basic shapes" className="grid grid-cols-5 gap-1">
                  {BASIC_SHAPES.map((s) => (
                    <button
                      key={s.tool}
                      type="button"
                      role="menuitem"
                      aria-label={s.label}
                      title={s.tool === "rect" ? `${s.label} (R)` : s.label}
                      onClick={(e) => {
                        setLastShape(s.tool);
                        setTool(s.tool);
                        if (e.detail === 2) onToggleLock();
                        close({ restoreFocus: false });
                      }}
                      className={cn(
                        "grid h-9 w-9 place-items-center rounded-lg outline-none transition-colors focus-visible:ring-2 focus-visible:ring-brand",
                        tool === s.tool
                          ? "bg-ink-600 ring-1 ring-line text-white"
                          : "text-white/60 hover:bg-white/[0.07] hover:text-white"
                      )}
                    >
                      <ShapeGlyph tool={s.tool} className="h-[18px] w-[18px]" />
                    </button>
                  ))}
                  <button
                    type="button"
                    role="menuitem"
                    aria-label="Line / arrow"
                    title="Line / arrow (connector)"
                    onClick={() => {
                      setTool("connector");
                      close({ restoreFocus: false });
                    }}
                    className={cn(
                      "grid h-9 w-9 place-items-center rounded-lg outline-none transition-colors focus-visible:ring-2 focus-visible:ring-brand",
                      tool === "connector"
                        ? "bg-ink-600 ring-1 ring-line text-white"
                        : "text-white/60 hover:bg-white/[0.07] hover:text-white"
                    )}
                  >
                    <MoveRight className="h-4 w-4" />
                  </button>
                </div>
              </div>
            )}
          </Dropdown>
        );
      case "frame":
        return (
          <ToolButton
            id="frame"
            active={tool === "frame"}
            icon={Frame}
            label="Frame / section"
            shortcut="F"
            locked={toolLocked && tool === "frame"}
            onClick={(e) => arm("frame", e)}
          />
        );
      case "connector":
        return (
          <ToolButton
            id="connector"
            active={tool === "connector"}
            icon={Spline}
            label="Connector"
            shortcut="C"
            locked={toolLocked && tool === "connector"}
            onClick={(e) => arm("connector", e)}
          />
        );
      case "image":
        return (
          <button
            type="button"
            className="grid h-9 w-9 cursor-pointer place-items-center rounded-lg text-white/55 transition-colors hover:bg-white/[0.07] hover:text-white max-sm:h-8 max-sm:w-8"
            title="Add image (⇧I)"
            aria-label="Add image"
            onClick={onAddImageClick}
          >
            <ImagePlus className="h-4 w-4" />
          </button>
        );
      case "ai":
        return (
          <button
            type="button"
            className={cn(
              "relative grid h-9 w-9 cursor-pointer place-items-center rounded-lg transition-colors max-sm:h-8 max-sm:w-8",
              aiOpen ? "bg-ink-600 text-white ring-1 ring-line" : "text-white/55 hover:bg-white/[0.07] hover:text-white"
            )}
            title="Create with AI"
            aria-label="Create with AI"
            aria-pressed={Boolean(aiOpen)}
            onClick={onAiClick}
          >
            <Sparkles className="h-4 w-4" />
            {aiRunning && <span className="absolute right-1 top-1 h-1.5 w-1.5 animate-pulse rounded-full bg-brand" aria-hidden />}
          </button>
        );
      default:
        return null;
    }
  };

  return (
    <>
      {/* The dock centres in the free strip between the asset panel and the
          zoom control; below the desktop width it sits above the zoom control,
          and on phones its buttons shrink so every tool fits the width. */}
      {!viewOnly && (
      <div
        className="pointer-events-none absolute bottom-4 right-44 z-30 flex justify-center transition-[left] duration-200 max-lg:bottom-[4.25rem] max-lg:right-4"
        style={{ left: insetLeft + 16 }}
      >
      <div
        role="toolbar"
        aria-label="Board tools"
        className="pointer-events-auto flex max-w-full items-center gap-1 overflow-x-auto rounded-2xl border border-line bg-ink-750/95 p-1.5 shadow-pop backdrop-blur-xl max-sm:gap-0.5 max-sm:p-1"
      >
        <ToolGroup>
          <ToolButton
            id="select"
            active={tool === "select"}
            icon={MousePointer2}
            label="Select"
            shortcut="V"
            onClick={(e) => arm("select", e)}
          />
          <ToolButton
            id="hand"
            active={tool === "hand"}
            icon={Hand}
            label="Hand"
            shortcut="H"
            onClick={(e) => arm("hand", e)}
          />
        </ToolGroup>

        {/* View and comment access: navigation only, no creation tools. */}
        {!readOnly && (<>
        <Divider />

        <ToolGroup>
          {pinnedTools(prefs).map((id) => (
            <Fragment key={id}>{renderCreationTool(id)}</Fragment>
          ))}
          <ToolbarCustomizer prefs={prefs} />
        </ToolGroup>

        <Divider />

        <ToolGroup>
          <button
            type="button"
            disabled={!canUndo}
            onClick={undo}
            aria-label="Undo"
            title="Undo (⌘Z)"
            className="grid h-9 w-9 place-items-center rounded-lg text-white/55 transition-colors hover:bg-white/[0.07] hover:text-white disabled:pointer-events-none disabled:opacity-30 max-sm:h-8 max-sm:w-8"
          >
            <Undo2 className="h-4 w-4" />
          </button>
          <button
            type="button"
            disabled={!canRedo}
            onClick={redo}
            aria-label="Redo"
            title="Redo (⇧⌘Z)"
            className="grid h-9 w-9 place-items-center rounded-lg text-white/55 transition-colors hover:bg-white/[0.07] hover:text-white disabled:pointer-events-none disabled:opacity-30 max-sm:h-8 max-sm:w-8"
          >
            <Redo2 className="h-4 w-4" />
          </button>
        </ToolGroup>
        </>)}
      </div>
      </div>
      )}

      <ZoomControl />
    </>
  );
}

function ToolGroup({ children }) {
  return <div className="flex items-center gap-1 max-sm:gap-0.5">{children}</div>;
}

function Divider() {
  return <span className="mx-0.5 h-5 w-px bg-line max-sm:mx-0" aria-hidden />;
}

function ToolButton({
  id: _id,
  active,
  icon: Icon,
  label,
  shortcut,
  locked,
  onClick,
}

) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      title={`${label} (${shortcut})`}
      className={cn(
        "relative grid h-9 w-9 place-items-center rounded-lg transition-colors max-sm:h-8 max-sm:w-8",
        active ? "text-white" : "text-white/55 hover:bg-white/[0.07] hover:text-white"
      )}
    >
      {active && (
        <motion.span
          layoutId="board-tool"
          transition={{ type: "spring", stiffness: 420, damping: 34 }}
          className="absolute inset-0 rounded-lg bg-ink-600 ring-1 ring-line"
        />
      )}
      <Icon className="relative z-10 h-4 w-4" />
      {locked && (
        <span className="absolute bottom-0.5 right-0.5 z-10 h-1.5 w-1.5 rounded-full bg-brand" />
      )}
    </button>
  );
}

function ZoomControl() {
  const zoom = useCanvasStore((s) => s.history.present.viewport.zoom);
  const setViewport = useCanvasStore((s) => s.setViewport);
  const zoomToFit = useCanvasStore((s) => s.zoomToFit);
  const selection = useCanvasStore((s) => s.selection);
  const present = useCanvasStore((s) => s.history.present);

  const step = (factor) => {
    const vp = present.viewport;
    const next = Math.min(4, Math.max(0.1, vp.zoom * factor));
    setViewport({ ...vp, zoom: next });
  };

  const zoomToSelection = () => {
    if (!selection.length) return;
    const selected = new Set(selection);
    const nodes = present.nodes.filter((n) => selected.has(n.id));
    if (!nodes.length) return;
    const bounds = nodes.map(nodeBounds);
    const x0 = Math.min(...bounds.map((b) => b.x));
    const y0 = Math.min(...bounds.map((b) => b.y));
    const x1 = Math.max(...bounds.map((b) => b.x + b.w));
    const y1 = Math.max(...bounds.map((b) => b.y + b.h));
    const w = Math.max(x1 - x0, 1);
    const h = Math.max(y1 - y0, 1);
    const pad = 160;
    // No container-pixel-size prop is threaded to this component; the window
    // size is a reasonable best-effort stand-in for "fit the selection".
    const viewW = Math.max(window.innerWidth - 420, 320);
    const viewH = Math.max(window.innerHeight - 220, 240);
    const nextZoom = Math.min(4, Math.max(0.1, Math.min(viewW / (w + pad), viewH / (h + pad))));
    setViewport({
      zoom: nextZoom,
      x: (x0 + x1) / 2 - viewW / 2 / nextZoom,
      y: (y0 + y1) / 2 - viewH / 2 / nextZoom,
    });
  };

  return (
    <div
      role="group"
      aria-label="Zoom"
      className="absolute bottom-4 right-4 z-30 flex items-center gap-1 rounded-lg border border-line bg-ink-800 p-1 shadow-pop"
    >
      <button
        type="button"
        aria-label="Zoom out"
        title="Zoom out (⌘−)"
        onClick={() => step(1 / 1.2)}
        className="grid h-7 w-7 place-items-center rounded-md text-white/55 transition hover:bg-white/[0.07] hover:text-white"
      >
        <Minus className="h-3.5 w-3.5" />
      </button>

      <Dropdown
        trigger={(open) => (
          <span
            className={cn(
              "flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-white/80 transition hover:bg-white/[0.07]",
              open && "bg-white/[0.07]"
            )}
          >
            {Math.round(zoom * 100)}%
            <ChevronDown className={cn("h-3 w-3 transition-transform", open && "rotate-180")} />
          </span>
        )}
      >
        {(close) => (
          <>
            <MenuItem
              onClick={() => {
                step(1.2);
                close();
              }}
            >
              <ZoomIn className="h-4 w-4 text-white/45" />
              <span className="flex-1">Zoom in</span>
              <span className="text-xs text-white/40">⌘+</span>
            </MenuItem>
            <MenuItem
              onClick={() => {
                step(1 / 1.2);
                close();
              }}
            >
              <ZoomOut className="h-4 w-4 text-white/45" />
              <span className="flex-1">Zoom out</span>
              <span className="text-xs text-white/40">⌘−</span>
            </MenuItem>
            <MenuItem
              onClick={() => {
                zoomToFit();
                close();
              }}
            >
              <span className="w-4" />
              <span className="flex-1">Zoom to fit</span>
              <span className="text-xs text-white/40">⇧1</span>
            </MenuItem>
            <MenuItem
              disabled={!selection.length}
              onClick={() => {
                zoomToSelection();
                close();
              }}
            >
              <span className="w-4" />
              <span className="flex-1">Zoom to selection</span>
              <span className="text-xs text-white/40">⇧2</span>
            </MenuItem>
            <MenuItem
              onClick={() => {
                setViewport({ ...present.viewport, zoom: 1 });
                close();
              }}
            >
              <span className="w-4" />
              <span className="flex-1">Zoom to 100%</span>
              <span className="text-xs text-white/40">⌘0</span>
            </MenuItem>
          </>
        )}
      </Dropdown>

      <button
        type="button"
        aria-label="Zoom in"
        title="Zoom in (⌘+)"
        onClick={() => step(1.2)}
        className="grid h-7 w-7 place-items-center rounded-md text-white/55 transition hover:bg-white/[0.07] hover:text-white"
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

/**
 * "Customize toolbar": pin or unpin each creation tool and put them in the
 * order this person likes, by dragging or with the move buttons. Saved on
 * this device; number keys 1 to 9 follow the same order.
 */
function ToolbarCustomizer({ prefs }) {
  const setPrefs = useBoardPrefs((s) => s.setPrefs);
  const [dragging, setDragging] = useState(null);
  const order = orderedTools(prefs);
  const hidden = new Set(prefs.toolbarHidden);

  return (
    <Dropdown
      side="top"
      label="Customize toolbar"
      panelClassName="min-w-0"
      trigger={(open) => (
        <span
          className={cn(
            "grid h-9 w-7 place-items-center rounded-lg text-white/40 transition-colors hover:bg-white/[0.07] hover:text-white max-sm:h-8",
            open && "bg-white/[0.07] text-white"
          )}
          title="Customize toolbar"
        >
          <SlidersHorizontal className="h-3.5 w-3.5" />
        </span>
      )}
    >
      {() => (
        <div className="w-64 p-0.5" data-board-keys="own">
          <p className="px-1.5 pb-1.5 pt-0.5 text-[11px] font-medium uppercase tracking-wide text-white/40">Toolbar tools</p>
          <ul aria-label="Toolbar tools" className="flex flex-col">
            {order.map((id, i) => (
              <li
                key={id}
                draggable
                onDragStart={(e) => {
                  setDragging(id);
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("text/plain", id);
                }}
                onDragEnd={() => setDragging(null)}
                onDragOver={(e) => {
                  if (dragging && dragging !== id) e.preventDefault();
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragging && dragging !== id) setPrefs(placeToolBefore(prefs, dragging, id));
                  setDragging(null);
                }}
                className={cn("flex cursor-grab items-center gap-2 rounded-lg px-1.5 py-1 hover:bg-white/[0.05]", dragging === id && "opacity-40")}
              >
                <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-sm text-white/80">
                  <input
                    type="checkbox"
                    checked={!hidden.has(id)}
                    onChange={() => setPrefs(togglePinned(prefs, id))}
                    className="h-3.5 w-3.5 accent-white"
                  />
                  <span className="truncate">{toolLabel(id)}</span>
                </label>
                <button
                  type="button"
                  aria-label={`Move ${toolLabel(id)} earlier`}
                  disabled={i === 0}
                  onClick={() => setPrefs(moveTool(prefs, id, -1))}
                  className="grid h-6 w-6 place-items-center rounded-md text-white/45 outline-none hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-25"
                >
                  <ArrowUp className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  aria-label={`Move ${toolLabel(id)} later`}
                  disabled={i === order.length - 1}
                  onClick={() => setPrefs(moveTool(prefs, id, 1))}
                  className="grid h-6 w-6 place-items-center rounded-md text-white/45 outline-none hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-25"
                >
                  <ArrowDown className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
          {order.length !== CREATION_TOOLS.length || prefs.toolbarOrder.length || prefs.toolbarHidden.length ? (
            <button
              type="button"
              onClick={() => setPrefs({ toolbarOrder: [], toolbarHidden: [] })}
              className="mt-1 w-full rounded-lg py-1.5 text-xs font-semibold text-white/60 outline-none hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-brand"
            >
              Reset to default
            </button>
          ) : null}
        </div>
      )}
    </Dropdown>
  );
}
