"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useCanvasStore } from "@/lib/canvas-store";
import { marqueeHits, nodeBounds, screenToWorld } from "@/lib/canvas/geometry";
import { lockedIdSet } from "@/lib/canvas/locks";
import { GRID_SIZE, useViewPrefs } from "@/lib/canvas/view-prefs";
import { lassoHits, preciseMarqueeHits } from "@/lib/canvas/selection-geometry";
import { SNAP_DISTANCE_PX, gridResizeDelta, snapCandidates, snapMove } from "@/lib/canvas/snapping";
import { applyDeltas, arrangeUnits, autoLayoutBaseGap, autoLayoutDeltas, dominantAxis, unionBounds } from "@/lib/canvas/arrange";

/** How long a mouse press holds still on the background to start a precise marquee. */
export const PRECISE_HOLD_MS = 500;
/** Screen pixels between recorded lasso points. */
const LASSO_STEP_PX = 3;
/** Screen pixels the spacing handle must travel before its direction is read. */
const LAYOUT_DIRECTION_PX = 6;

/**
 * The board surface's arrange gestures, kept out of CanvasSurface: the lasso,
 * the precise marquee, snapping (alignment guides and the grid) for moves and
 * resizes, and the auto layout spacing handle. CanvasSurface owns the pointer
 * routing and calls in here by drag kind; everything reads the board data.
 */
export function useArrangeGestures({ dragRef, view, viewport, size, setPreview, onTransientChange }) {
  const [lassoPoints, setLassoPoints] = useState(null);
  const [guides, setGuides] = useState([]);
  const [preciseMarquee, setPreciseMarquee] = useState(false);
  const holdTimer = useRef(null);

  const clearHold = () => {
    if (holdTimer.current) clearTimeout(holdTimer.current);
    holdTimer.current = null;
  };
  useEffect(() => clearHold, []);

  const select = (hits, additive) => {
    const s = useCanvasStore.getState();
    if (additive) s.setSelection(Array.from(new Set([...s.selection, ...hits])));
    else s.setSelection(hits);
  };

  // ---- marquee ----

  /** A mouse marquee turns precise when the press holds still long enough first. */
  const armPreciseMarquee = (drag) => {
    clearHold();
    holdTimer.current = setTimeout(() => {
      holdTimer.current = null;
      if (dragRef.current !== drag || drag.moved) return;
      drag.precise = true;
      setPreciseMarquee(true);
    }, PRECISE_HOLD_MS);
  };

  /** The ids a marquee over `rect` picks: precise for a held press or the personal preference. */
  const marqueeSelection = (state, rect, precise) =>
    precise || useViewPrefs.getState().preciseSelection ? preciseMarqueeHits(state, rect) : marqueeHits(state, rect);

  const endMarquee = () => {
    clearHold();
    setPreciseMarquee(false);
  };

  // ---- lasso ----

  const beginLasso = (screen, additive) => {
    const world = screenToWorld(screen, viewport);
    dragRef.current = { kind: "lasso", startScreen: screen, moved: false, additive, lastScreen: screen, points: [[world.x, world.y]] };
    setLassoPoints(dragRef.current.points);
  };

  const moveLasso = (drag, screen) => {
    if (Math.hypot(screen.x - drag.lastScreen.x, screen.y - drag.lastScreen.y) < LASSO_STEP_PX) return;
    const world = screenToWorld(screen, viewport);
    drag.lastScreen = screen;
    drag.points = [...drag.points, [world.x, world.y]];
    setLassoPoints(drag.points);
  };

  const endLasso = (drag) => {
    setLassoPoints(null);
    const s = useCanvasStore.getState();
    if (!drag.moved || drag.points.length < 3) {
      if (!drag.additive) s.clearSelection();
      return;
    }
    const hits = lassoHits(view, drag.points, { precise: useViewPrefs.getState().preciseSelection });
    select(hits, drag.additive);
  };

  // ---- snapping ----

  /**
   * The move delta after snapping, for a move drag of the current selection.
   * `lockX`/`lockY` keep a Shift-constrained axis at zero.
   */
  const snapMoveDelta = (drag, dx, dy, { lockX = false, lockY = false } = {}) => {
    const prefs = useViewPrefs.getState();
    const grid = prefs.snapToGrid ? GRID_SIZE : 0;
    if (!prefs.alignmentGuides && !grid) {
      if (guides.length) setGuides([]);
      return { dx, dy };
    }
    if (!drag.snap) {
      const { selection } = useCanvasStore.getState();
      const present = view;
      const locked = lockedIdSet(present);
      const moving = new Set(selection.filter((id) => !locked.has(id)));
      const box = unionBounds(present.nodes.filter((n) => moving.has(n.id)).map(nodeBounds));
      // A moved frame carries its children: they cannot be snap targets either.
      for (const n of present.nodes) if (n.parentId && moving.has(n.parentId)) moving.add(n.id);
      const near = {
        x: viewport.x - size.w / viewport.zoom / 2,
        y: viewport.y - size.h / viewport.zoom / 2,
        w: (size.w / viewport.zoom) * 2,
        h: (size.h / viewport.zoom) * 2,
      };
      const focus = box ? { x: box.x + box.w / 2, y: box.y + box.h / 2 } : { x: 0, y: 0 };
      drag.snap = { box, candidates: box && prefs.alignmentGuides ? snapCandidates(present, moving, near, focus) : [] };
    }
    if (!drag.snap.box) return { dx, dy };
    const out = snapMove(drag.snap.box, dx, dy, {
      candidates: drag.snap.candidates,
      threshold: SNAP_DISTANCE_PX / viewport.zoom,
      guides: prefs.alignmentGuides,
      grid,
    });
    const next = {
      dx: lockX ? 0 : out.dx,
      dy: lockY ? 0 : out.dy,
    };
    const shown = out.guides.filter((g) => (g.axis === "x" ? !lockX : !lockY));
    if (shown.length || guides.length) setGuides(shown);
    return next;
  };

  /** The resize delta with the dragged edges on the grid, when snap to grid is on. */
  const snapResizeDelta = (startNode, handle, dx, dy, keepAspect) => {
    // Shift keeps the aspect ratio and a rotated box has no grid-aligned edges: both resize freely.
    if (!useViewPrefs.getState().snapToGrid || keepAspect || startNode.rotation) return { dx, dy };
    return gridResizeDelta(startNode, handle, dx, dy, GRID_SIZE);
  };

  const clearGuides = () => setGuides((g) => (g.length ? [] : g));

  // ---- auto layout handle ----

  const beginLayout = useCallback(
    (e) => {
      e.stopPropagation();
      e.preventDefault();
      if (e.button !== undefined && e.button !== 0) return;
      e.currentTarget.setPointerCapture?.(e.pointerId);
      const { selection } = useCanvasStore.getState();
      const rect = e.currentTarget.closest('[role="application"]')?.getBoundingClientRect();
      const screen = { x: e.clientX - (rect?.left ?? 0), y: e.clientY - (rect?.top ?? 0) };
      dragRef.current = {
        kind: "layout",
        startScreen: screen,
        moved: false,
        base: view,
        ids: selection,
        // Until the pointer shows a direction, the objects keep the axis they already run along.
        axis: dominantAxis(view, selection),
        gaps: { x: autoLayoutBaseGap(view, selection, "x"), y: autoLayoutBaseGap(view, selection, "y") },
        count: arrangeUnits(view, selection).length,
      };
      onTransientChange?.(true);
    },
    [dragRef, view, onTransientChange]
  );

  /** Live preview of the row or column for a handle dragged by (worldDx, worldDy). */
  const moveLayout = (drag, worldDx, worldDy, screenDx, screenDy) => {
    if (Math.max(Math.abs(screenDx), Math.abs(screenDy)) >= LAYOUT_DIRECTION_PX) {
      drag.axis = Math.abs(screenDx) >= Math.abs(screenDy) ? "x" : "y";
    }
    const along = drag.axis === "x" ? worldDx : worldDy;
    drag.gap = Math.max(0, Math.round(drag.gaps[drag.axis] + along / Math.max(1, drag.count - 1)));
    setPreview(applyDeltas(drag.base, autoLayoutDeltas(drag.base, drag.ids, drag.axis, drag.gap)));
  };

  const endLayout = (drag) => {
    setPreview(null);
    onTransientChange?.(false);
    if (drag.moved && drag.gap !== undefined) useCanvasStore.getState().autoLayoutSelection(drag.axis, drag.gap);
  };

  /** Drops any arrange gesture in flight without committing it. */
  const cancel = () => {
    clearHold();
    setPreciseMarquee(false);
    setLassoPoints(null);
    setGuides([]);
  };

  return {
    lassoPoints,
    guides,
    preciseMarquee,
    armPreciseMarquee,
    marqueeSelection,
    endMarquee,
    beginLasso,
    moveLasso,
    endLasso,
    snapMoveDelta,
    snapResizeDelta,
    clearGuides,
    beginLayout,
    moveLayout,
    endLayout,
    cancel,
  };
}
