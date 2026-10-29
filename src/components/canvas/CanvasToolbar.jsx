"use client";

import { useState } from "react";
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
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useCanvasStore, } from "@/lib/canvas-store";
import { nodeBounds } from "@/lib/canvas/geometry";
import { Dropdown, MenuItem } from "@/components/Dropdown";
import { BASIC_SHAPES, isShapeTool } from "@/lib/canvas/shapes";
import { ShapeGlyph } from "./ShapeGlyph";

/**
 * Bottom-center floating tool dock (ui-spec §3) + bottom-right zoom control
 * (§2). Both are separate floating layers per the ui-spec's layer diagram;
 * they're implemented from this one file since the file plan has no
 * dedicated component for the zoom control.
 */
export function CanvasToolbar({
  readOnly = false,
  toolLocked,
  shapesOpen,
  onShapesOpenChange,
  onToggleLock,
  onAddImageClick,
}

) {
  const tool = useCanvasStore((s) => s.tool);
  const setTool = useCanvasStore((s) => s.setTool);
  const [lastShape, setLastShape] = useState("rect");

  const shapeToolActive = isShapeTool(tool);
  const shapeButtonTool = shapeToolActive ? tool : lastShape;

  const arm = (id, e) => {
    setTool(id);
    if (e?.detail === 2) onToggleLock();
  };

  return (
    <>
      <div
        role="toolbar"
        aria-label="Board tools"
        className="absolute bottom-4 left-1/2 z-30 flex -translate-x-1/2 items-center gap-1 rounded-2xl border border-line bg-ink-750/95 p-1.5 shadow-pop backdrop-blur-xl"
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
          <ToolButton
            id="sticky"
            active={tool === "sticky"}
            icon={StickyNote}
            label="Sticky note"
            shortcut="N"
            locked={toolLocked && tool === "sticky"}
            onClick={(e) => arm("sticky", e)}
          />
          <ToolButton
            id="text"
            active={tool === "text"}
            icon={Type}
            label="Text"
            shortcut="T"
            locked={toolLocked && tool === "text"}
            onClick={(e) => arm("text", e)}
          />

          <Dropdown
            side="top"
            label="Shapes"
            open={shapesOpen}
            onOpenChange={onShapesOpenChange}
            panelClassName="min-w-0"
            trigger={(open) => (
              <span
                className={cn(
                  "relative grid h-9 w-9 place-items-center rounded-lg transition-colors",
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

          <ToolButton
            id="frame"
            active={tool === "frame"}
            icon={Frame}
            label="Frame / section"
            shortcut="F"
            locked={toolLocked && tool === "frame"}
            onClick={(e) => arm("frame", e)}
          />
          <ToolButton
            id="connector"
            active={tool === "connector"}
            icon={Spline}
            label="Connector"
            shortcut="C"
            locked={toolLocked && tool === "connector"}
            onClick={(e) => arm("connector", e)}
          />
        </ToolGroup>

        <Divider />

        <ToolGroup>
          <button
            type="button"
            className="grid h-9 w-9 cursor-pointer place-items-center rounded-lg text-white/55 transition-colors hover:bg-white/[0.07] hover:text-white"
            title="Add image (⇧I)"
            aria-label="Add image"
            onClick={onAddImageClick}
          >
            <ImagePlus className="h-4 w-4" />
          </button>
        </ToolGroup>
        </>)}
      </div>

      <ZoomControl />
    </>
  );
}

function ToolGroup({ children }) {
  return <div className="flex items-center gap-1">{children}</div>;
}

function Divider() {
  return <span className="mx-0.5 h-5 w-px bg-line" aria-hidden />;
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
        "relative grid h-9 w-9 place-items-center rounded-lg transition-colors",
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
    const nodes = present.nodes.filter((n) => selection.includes(n.id));
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
    <div className="absolute bottom-4 right-4 z-30 flex items-center gap-1 rounded-lg border border-line bg-ink-800 p-1 shadow-pop">
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
