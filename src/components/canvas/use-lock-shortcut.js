"use client";

import { useEffect } from "react";
import { useStore } from "@/lib/store";
import { useCanvasStore, selectReadOnly } from "@/lib/canvas-store";

/** The signed-in person's id as board data names people (a string), or null. */
export function currentActorId() {
  const id = useStore.getState().currentUser?.id;
  return id == null ? null : String(id);
}

/**
 * Cmd/Ctrl+Shift+L locks the selection, or unlocks it when every selected
 * object is already locked (Miro's shortcut). Not while typing, nor for
 * people who cannot edit the board or are only viewing it on touch.
 */
export function useLockShortcut(disabled = false) {
  useEffect(() => {
    if (disabled) return undefined;
    const onKeyDown = (e) => {
      if (!(e.metaKey || e.ctrlKey) || !e.shiftKey || e.altKey || e.code !== "KeyL") return;
      const target = e.target;
      if (
        target?.isContentEditable ||
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.tagName === "SELECT" ||
        target?.closest?.('[role="dialog"], [role="alertdialog"]')
      ) {
        return;
      }
      const state = useCanvasStore.getState();
      if (selectReadOnly(state) || !state.selection.length) return;
      e.preventDefault();
      state.toggleLockSelection(currentActorId());
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [disabled]);
}
