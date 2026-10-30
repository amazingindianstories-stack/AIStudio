"use client";

import { useEffect, useState } from "react";
import { MoveHorizontal } from "lucide-react";
import { useCanvasStore } from "@/lib/canvas-store";
import { hitTest, nodeBounds, screenToWorld, unionBounds, worldToScreen } from "@/lib/canvas/geometry";
import { arrangeUnits } from "@/lib/canvas/arrange";
import { measureGaps } from "@/lib/canvas/snapping";

const GUIDE_COLOR = "#f43f5e";
const RULER_COLOR = "#38bdf8";

/**
 * Screen-space drawings for the arrange gestures: the lasso path, alignment
 * guides while moving, the precise-marquee hint, and the Option/Alt distance
 * ruler between the selected object and the one under the pointer. Purely
 * visual (pointer-events: none); positions come from the board data.
 */
export function ArrangeOverlay({ containerRef, view, viewport, lassoPoints, guides, marqueeScreen, preciseMarquee, disabled }) {
  const ruler = useDistanceRuler(containerRef, view, viewport, disabled);
  const toScreen = (x, y) => worldToScreen({ x, y }, viewport);

  return (
    <svg className="pointer-events-none absolute inset-0 z-20 h-full w-full overflow-visible" aria-hidden>
      {lassoPoints && lassoPoints.length > 1 && (
        <polygon
          data-testid="lasso-path"
          points={lassoPoints.map(([x, y]) => {
            const p = toScreen(x, y);
            return `${p.x},${p.y}`;
          }).join(" ")}
          fill="rgba(56,189,248,0.08)"
          stroke="#38bdf8"
          strokeWidth={1.5}
          strokeDasharray="5 4"
          strokeLinejoin="round"
        />
      )}

      {guides.map((g) => {
        const a = g.axis === "x" ? toScreen(g.at, g.from) : toScreen(g.from, g.at);
        const b = g.axis === "x" ? toScreen(g.at, g.to) : toScreen(g.to, g.at);
        return (
          <line
            key={`${g.axis}:${g.at}`}
            data-testid="alignment-guide"
            x1={a.x}
            y1={a.y}
            x2={b.x}
            y2={b.y}
            stroke={GUIDE_COLOR}
            strokeWidth={1}
            shapeRendering="crispEdges"
          />
        );
      })}

      {preciseMarquee && marqueeScreen && (
        <g data-testid="precise-marquee">
          <rect
            x={Math.min(marqueeScreen.x0, marqueeScreen.x1)}
            y={Math.min(marqueeScreen.y0, marqueeScreen.y1)}
            width={Math.abs(marqueeScreen.x1 - marqueeScreen.x0)}
            height={Math.abs(marqueeScreen.y1 - marqueeScreen.y0)}
            fill="rgba(56,189,248,0.08)"
            stroke="#38bdf8"
            strokeWidth={1.5}
            strokeDasharray="6 4"
          />
          <Label x={Math.min(marqueeScreen.x0, marqueeScreen.x1)} y={Math.min(marqueeScreen.y0, marqueeScreen.y1) - 14} text="Precise selection" anchor="start" />
        </g>
      )}

      {ruler &&
        ruler.map((m, i) => {
          const a = m.axis === "x" ? toScreen(m.from, m.at) : toScreen(m.at, m.from);
          const b = m.axis === "x" ? toScreen(m.to, m.at) : toScreen(m.at, m.to);
          return (
            <g key={i} data-testid="distance-ruler">
              <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={RULER_COLOR} strokeWidth={1} shapeRendering="crispEdges" />
              <Tick at={a} axis={m.axis} />
              <Tick at={b} axis={m.axis} />
              <Label x={(a.x + b.x) / 2} y={(a.y + b.y) / 2} text={String(m.value)} />
            </g>
          );
        })}
    </svg>
  );
}

function Tick({ at, axis }) {
  return axis === "x" ? (
    <line x1={at.x} y1={at.y - 4} x2={at.x} y2={at.y + 4} stroke={RULER_COLOR} strokeWidth={1} />
  ) : (
    <line x1={at.x - 4} y1={at.y} x2={at.x + 4} y2={at.y} stroke={RULER_COLOR} strokeWidth={1} />
  );
}

function Label({ x, y, text, anchor = "middle" }) {
  const width = text.length * 6.5 + 10;
  const left = anchor === "middle" ? x - width / 2 : x;
  return (
    <g>
      <rect x={left} y={y - 9} width={width} height={18} rx={4} fill="#0ea5e9" />
      <text x={left + width / 2} y={y + 4} textAnchor="middle" fontSize={11} fontWeight={600} fill="#fff">
        {text}
      </text>
    </g>
  );
}

/**
 * While Option/Alt is held with one object selected, the distances from it to
 * the object under the pointer (found by hit-testing the visible board data).
 */
function useDistanceRuler(containerRef, present, viewport, disabled) {
  const [altHeld, setAltHeld] = useState(false);
  const [pointer, setPointer] = useState(null);
  const selection = useCanvasStore((s) => s.selection);

  useEffect(() => {
    const down = (e) => {
      if (e.key === "Alt") setAltHeld(true);
    };
    const up = (e) => {
      if (e.key === "Alt") setAltHeld(false);
    };
    const reset = () => setAltHeld(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", reset);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", reset);
    };
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const move = (e) => {
      if (e.pointerType === "touch") return;
      const rect = el.getBoundingClientRect();
      setAltHeld(e.altKey);
      // Only tracked while Alt is held; a pressed button means a drag (Alt-drag duplicates), so no ruler.
      setPointer(e.altKey && !e.buttons ? { x: e.clientX - rect.left, y: e.clientY - rect.top } : null);
    };
    const leave = () => setPointer(null);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerleave", leave);
    return () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerleave", leave);
    };
  }, [containerRef]);

  if (disabled || !altHeld || !pointer || selection.length !== 1) return null;
  const selected = present.nodes.find((n) => n.id === selection[0]);
  if (!selected) return null;
  const hoveredId = hitTest(present, screenToWorld(pointer, viewport));
  if (!hoveredId || hoveredId === selected.id) return null;
  const hovered = present.nodes.find((n) => n.id === hoveredId);
  return measureGaps(nodeBounds(selected), nodeBounds(hovered));
}

/**
 * The spacing handle on a multi-selection: drag it to lay the objects out in
 * an evenly spaced row (drag sideways) or column (drag up or down). Drawn in
 * world space at the selection box's bottom-right corner, at a constant
 * screen size.
 */
export function AutoLayoutHandle({ state, ids, zoom, onPointerDown }) {
  const units = arrangeUnits(state, ids);
  if (units.length < 2) return null;
  const box = unionBounds(units.map((u) => u.box));
  const sizePx = 22;
  const s = sizePx / zoom;
  const offset = 10 / zoom;
  return (
    <button
      type="button"
      data-testid="auto-layout-handle"
      aria-label="Drag to space evenly in a row or column"
      title="Drag to space evenly in a row or column"
      onPointerDown={onPointerDown}
      className="absolute grid cursor-grab place-items-center rounded-full border border-brand/70 bg-ink-750 text-white/80 shadow-pop hover:bg-ink-600 active:cursor-grabbing"
      style={{
        left: box.x + box.w + offset,
        top: box.y + box.h + offset,
        width: sizePx,
        height: sizePx,
        transform: `scale(${s / sizePx})`,
        transformOrigin: "top left",
      }}
    >
      <MoveHorizontal className="h-3.5 w-3.5" />
    </button>
  );
}
