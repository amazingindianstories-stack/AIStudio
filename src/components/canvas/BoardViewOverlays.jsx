"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { useCanvasStore } from "@/lib/canvas-store";
import { nodeBounds, unionBounds, worldToScreen } from "@/lib/canvas/geometry";
import { layeredView } from "@/lib/canvas/layers";
import { useViewPrefs } from "@/lib/canvas/view-prefs";
import {
  centerViewportOn,
  fromMinimap,
  minimapTransform,
  navigationExtent,
  scrollThumb,
  selectionSize,
  toMinimap,
  viewRect,
} from "@/lib/canvas/board-view";

const MAP_W = 200;
const MAP_H = 128;
// Keeps the view rectangle's outline off the map's border.
const MAP_INSET = 6;

/**
 * Screen-space aids over the board: the selection size label, optional
 * scroll bars and the minimap. Everything reads the board data in the store,
 * so objects that viewport culling has not mounted still count.
 */
export function BoardViewOverlays({ insetLeft = 0, gestureActive = false }) {
  const ref = useRef(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const minimap = useViewPrefs((s) => s.minimap);
  const scrollbars = useViewPrefs((s) => s.scrollbars);
  const showDimensions = useViewPrefs((s) => s.showDimensions);
  const loaded = useCanvasStore((s) => s.loaded && Boolean(s.boardId));
  const boardState = useCanvasStore((s) => s.history.present);
  const hiddenLayerIds = useCanvasStore((s) => s.hiddenLayerIds);
  const present = useMemo(() => layeredView(boardState, hiddenLayerIds), [boardState, hiddenLayerIds]);
  const viewport = present.viewport;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r) setSize({ w: r.width, h: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const bounds = useMemo(() => (minimap || scrollbars ? present.nodes.map(nodeBounds) : []), [present.nodes, minimap, scrollbars]);
  const content = useMemo(() => unionBounds(bounds), [bounds]);
  const ready = loaded && size.w > 0 && size.h > 0;

  return (
    <div ref={ref} className="pointer-events-none absolute inset-0 z-20 overflow-hidden" aria-hidden={!ready}>
      {ready && showDimensions && !gestureActive && <SelectionSizeLabel present={present} viewport={viewport} />}
      {ready && scrollbars && <ScrollBars content={content} viewport={viewport} size={size} insetLeft={insetLeft} />}
      {ready && minimap && <Minimap present={present} bounds={bounds} content={content} viewport={viewport} size={size} />}
    </div>
  );
}

function SelectionSizeLabel({ present, viewport }) {
  const selection = useCanvasStore((s) => s.selection);
  const busy = useCanvasStore((s) => Boolean(s.editingTextId || s.croppingImageId));
  const label = useMemo(() => {
    if (!selection.length) return null;
    const selected = new Set(selection);
    return selectionSize(present.nodes.filter((n) => selected.has(n.id)), nodeBounds);
  }, [present.nodes, selection]);
  if (!label || busy) return null;
  const anchor = worldToScreen({ x: label.box.x + label.box.w / 2, y: label.box.y + label.box.h }, viewport);
  return (
    <div
      data-testid="selection-size"
      className="absolute -translate-x-1/2 whitespace-nowrap rounded-md bg-ink-700/95 px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-white/80 shadow-pop ring-1 ring-line"
      style={{ left: anchor.x, top: anchor.y + 10 }}
    >
      {label.w} x {label.h}
    </div>
  );
}

const BAR = 6;
const BAR_GAP = 4;

function ScrollBars({ content, viewport, size, insetLeft }) {
  const view = viewRect(viewport, size);
  const extent = navigationExtent(content, view);
  // The horizontal bar runs under the tool dock, clear of the asset panel; the
  // vertical one between the board's top bar and the zoom control.
  const h = { start: insetLeft + 8, length: size.w - insetLeft - 8 - 16 };
  const v = { start: 64, length: size.h - 128 };
  return (
    <>
      {h.length > 40 && (
        <ScrollBar
          axis="x"
          track={h}
          thumb={scrollThumb(extent.x, extent.w, view.x, view.w, h.length)}
          viewport={viewport}
          viewLength={view.w}
        />
      )}
      {v.length > 40 && (
        <ScrollBar
          axis="y"
          track={v}
          thumb={scrollThumb(extent.y, extent.h, view.y, view.h, v.length)}
          viewport={viewport}
          viewLength={view.h}
        />
      )}
    </>
  );
}

function ScrollBar({ axis, track, thumb, viewport, viewLength }) {
  const dragRef = useRef(null);
  if (thumb.length >= track.length) return null; // the whole board is in view
  const horizontal = axis === "x";
  const setAxis = (value) => useCanvasStore.getState().setViewport({ ...useCanvasStore.getState().history.present.viewport, [axis]: value });

  const onThumbDown = (e) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    dragRef.current = { from: horizontal ? e.clientX : e.clientY, start: viewport[axis], ratio: thumb.ratio };
  };
  const onThumbMove = (e) => {
    const drag = dragRef.current;
    if (!drag) return;
    setAxis(drag.start + ((horizontal ? e.clientX : e.clientY) - drag.from) * drag.ratio);
  };
  const onThumbUp = () => {
    dragRef.current = null;
  };
  // A press on the track pages one view towards it.
  const onTrackDown = (e) => {
    if (e.target !== e.currentTarget) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const at = horizontal ? e.clientX - rect.left : e.clientY - rect.top;
    setAxis(viewport[axis] + (at < thumb.offset ? -1 : 1) * viewLength * 0.9);
  };

  const trackStyle = horizontal
    ? { left: track.start, width: track.length, bottom: BAR_GAP, height: BAR }
    : { top: track.start, height: track.length, right: BAR_GAP, width: BAR };
  const thumbStyle = horizontal
    ? { left: thumb.offset, width: thumb.length, top: 0, bottom: 0 }
    : { top: thumb.offset, height: thumb.length, left: 0, right: 0 };
  return (
    <div
      data-testid={`board-scrollbar-${axis}`}
      className="pointer-events-auto absolute rounded-full"
      style={trackStyle}
      onPointerDown={onTrackDown}
    >
      <div
        data-testid={`board-scrollbar-${axis}-thumb`}
        className="absolute touch-none rounded-full bg-white/20 transition-colors hover:bg-white/40 active:bg-white/45"
        style={thumbStyle}
        onPointerDown={onThumbDown}
        onPointerMove={onThumbMove}
        onPointerUp={onThumbUp}
        onPointerCancel={onThumbUp}
      />
    </div>
  );
}

function Minimap({ present, bounds, content, viewport, size }) {
  const canvasRef = useRef(null);
  // While dragging, the map holds still so the view follows the pointer.
  const [held, setHeld] = useState(null);
  const view = viewRect(viewport, size);
  const transform = held ?? minimapTransform(navigationExtent(content, view), MAP_W, MAP_H, MAP_INSET);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== MAP_W * dpr) {
      canvas.width = MAP_W * dpr;
      canvas.height = MAP_H * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, MAP_W, MAP_H);
    present.nodes.forEach((n, i) => {
      const r = toMinimap(transform, bounds[i] ?? nodeBounds(n));
      const w = Math.max(r.w, 1);
      const h = Math.max(r.h, 1);
      if (n.type === "frame") {
        ctx.strokeStyle = "rgba(255,255,255,0.28)";
        ctx.lineWidth = 1;
        ctx.strokeRect(r.x + 0.5, r.y + 0.5, w - 1, h - 1);
        return;
      }
      ctx.fillStyle = n.type === "image" ? "rgba(148,163,184,0.55)" : typeof n.fill === "string" && n.fill.startsWith("#") ? n.fill : "rgba(255,255,255,0.4)";
      ctx.globalAlpha = n.type === "image" ? 1 : 0.85;
      ctx.fillRect(r.x, r.y, w, h);
      ctx.globalAlpha = 1;
    });
    const vr = toMinimap(transform, view);
    ctx.fillStyle = "rgba(255,255,255,0.06)";
    ctx.fillRect(vr.x, vr.y, vr.w, vr.h);
    ctx.strokeStyle = "rgba(255,255,255,0.75)";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(vr.x, vr.y, vr.w, vr.h);
  }, [present.nodes, bounds, transform, view]);

  const panTo = (e, mapping) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const world = fromMinimap(mapping, { x: e.clientX - rect.left, y: e.clientY - rect.top });
    const vp = useCanvasStore.getState().history.present.viewport;
    useCanvasStore.getState().setViewport(centerViewportOn(vp, world, size));
  };

  return (
    <div
      className={cn(
        "pointer-events-auto absolute bottom-16 right-4 overflow-hidden rounded-lg border border-line bg-ink-800/90 shadow-pop backdrop-blur-xl max-lg:bottom-[8rem] max-sm:hidden"
      )}
      style={{ width: MAP_W + 2, height: MAP_H + 2 }}
    >
      <canvas
        ref={canvasRef}
        role="img"
        aria-label="Minimap: press or drag to move the view"
        data-testid="board-minimap"
        className="block cursor-pointer touch-none"
        style={{ width: MAP_W, height: MAP_H }}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture?.(e.pointerId);
          setHeld(transform);
          panTo(e, transform);
        }}
        onPointerMove={(e) => {
          if (held) panTo(e, held);
        }}
        onPointerUp={() => setHeld(null)}
        onPointerCancel={() => setHeld(null)}
      />
    </div>
  );
}
