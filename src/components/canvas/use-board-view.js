"use client";

import { useEffect } from "react";
import { MotionGlobalConfig } from "framer-motion";
import { useCanvasStore } from "@/lib/canvas-store";
import { nextGridStyle } from "@/lib/canvas/board-view";
import { prefersReducedMotion, useViewPrefs } from "@/lib/canvas/view-prefs";
import { ZOOM_STEP, keyboardZoomDirection, zoomAboutCenter } from "@/lib/canvas/viewport-nav";
import { exitFullscreen } from "./use-board-fullscreen";

function typingInto(target) {
  return Boolean(
    target?.isContentEditable ||
      target?.tagName === "INPUT" ||
      target?.tagName === "TEXTAREA" ||
      target?.tagName === "SELECT" ||
      target?.closest?.('[role="dialog"], [role="alertdialog"]')
  );
}

/**
 * Board view setup for CanvasView: loads this person's view preferences,
 * the view shortcuts (Cmd/Ctrl + plus/minus zoom, M minimap, G grid), and
 * reduced motion while the board is open. None of these edit the board, so
 * they work for viewers too.
 */
export function useBoardView() {
  useEffect(() => {
    useViewPrefs.getState().load();
  }, []);

  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.defaultPrevented || typingInto(e.target)) return;
      const direction = keyboardZoomDirection(e);
      if (direction) {
        // Also keeps the browser from zooming the whole page.
        e.preventDefault();
        const state = useCanvasStore.getState();
        if (!state.loaded || !state.boardId) return;
        const factor = direction > 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
        state.setViewport(zoomAboutCenter(state.history.present.viewport, factor, state.viewportSize()));
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.repeat) return;
      const key = e.key.toLowerCase();
      const prefs = useViewPrefs.getState();
      if (key === "m") {
        e.preventDefault();
        prefs.togglePref("minimap");
      } else if (key === "g") {
        e.preventDefault();
        prefs.setPref("grid", nextGridStyle(prefs.grid));
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  // Reduced motion: the system setting or this person's toggle makes board
  // animations instant, framer-motion ones and CSS transitions alike.
  const reduceMotion = useViewPrefs((s) => s.reduceMotion);
  useEffect(() => {
    const root = document.documentElement;
    let query = null;
    const apply = () => {
      const reduce = prefersReducedMotion();
      MotionGlobalConfig.skipAnimations = reduce;
      if (reduce) root.dataset.boardReduceMotion = "true";
      else delete root.dataset.boardReduceMotion;
    };
    apply();
    try {
      query = window.matchMedia("(prefers-reduced-motion: reduce)");
      query.addEventListener("change", apply);
    } catch {
      query = null;
    }
    return () => {
      query?.removeEventListener("change", apply);
      MotionGlobalConfig.skipAnimations = false;
      delete root.dataset.boardReduceMotion;
    };
  }, [reduceMotion]);

  // Full screen belongs to the board: leaving it leaves full screen.
  useEffect(() => () => void exitFullscreen(), []);
}
