"use client";

import { useEffect } from "react";
import { useCanvasStore } from "@/lib/canvas-store";
import { useViewPrefs } from "@/lib/canvas/view-prefs";
import { wheelViewport } from "@/lib/canvas/viewport-nav";

/**
 * Wheel and two-finger trackpad navigation on the board, following the
 * person's navigation mode (see wheelIntent). Attached natively and not
 * passive, so a pinch or Cmd/Ctrl + wheel zooms the board rather than the
 * page, and a sideways swipe never triggers browser back navigation.
 */
export function useBoardWheel(containerRef) {
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const point = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      const state = useCanvasStore.getState();
      const viewport = state.history.present.viewport;
      const next = wheelViewport(viewport, point, e, useViewPrefs.getState().navigationMode, rect.height);
      if (next !== viewport) state.setViewport(next);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [containerRef]);
}
