"use client";

import { useEffect } from "react";
import { useCanvasStore, selectReadOnly } from "@/lib/canvas-store";

const DIRECTIONS = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
};

function typing(target) {
  return (
    target?.isContentEditable ||
    target?.tagName === "INPUT" ||
    target?.tagName === "TEXTAREA" ||
    target?.tagName === "SELECT" ||
    target?.closest?.('[role="dialog"], [role="alertdialog"], [role="menu"]')
  );
}

/**
 * Option/Alt+Arrow duplicates the selection beside itself (smart duplicate),
 * and Cmd/Ctrl+Backspace clears the text of the selected objects. Listens on
 * the window in the capture phase so it runs before the board's own key
 * handler, which would otherwise nudge (Arrow) or delete (Backspace). Not
 * while typing, nor for people who cannot edit or are only viewing on touch.
 */
export function useArrangeShortcuts(disabled = false) {
  useEffect(() => {
    if (disabled) return undefined;
    const onKeyDown = (e) => {
      const direction = DIRECTIONS[e.key];
      const duplicate = direction && e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey;
      const clear = e.key === "Backspace" && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey;
      if (!duplicate && !clear) return;
      if (typing(e.target)) return;
      const state = useCanvasStore.getState();
      if (selectReadOnly(state) || !state.selection.length || state.editingTextId || state.croppingImageId) return;
      e.preventDefault();
      e.stopPropagation();
      if (duplicate) state.duplicateSelectionToward(direction);
      else state.clearSelectedContent();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [disabled]);
}
