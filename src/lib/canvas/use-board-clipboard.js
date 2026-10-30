"use client";

import { useEffect } from "react";
import { clipboardNodes, selectReadOnly, useCanvasStore } from "@/lib/canvas-store";
import { boardClipboardData, clipboardCells, isBoardCopy } from "./board-clipboard";
import { pasteCellsAsStickies } from "./sticky-actions";

let keyboardCopyAt = -Infinity;

/** Called as the board's copy or cut shortcut copies, just before the browser's copy or cut event. */
export function noteKeyboardCopy() {
  keyboardCopyAt = Date.now();
}

function typing(target) {
  return target?.isContentEditable || target?.tagName === "INPUT" || target?.tagName === "TEXTAREA";
}

/**
 * Board copy, cut and paste through the browser's clipboard events. Copy and
 * cut also mark the system clipboard (board-clipboard.js). A paste adds
 * image files, the board's own copied objects when they were copied last,
 * or one sticky per spreadsheet cell, centered on the view.
 */
export function useBoardClipboard({ importImageFiles, touchViewOnly, viewCenter, notify }) {
  useEffect(() => {
    const onCopy = (event) => {
      if (typing(event.target) || !event.clipboardData) return;
      // The shortcut already copied (and for cut, deleted); a menu copy or cut copies here.
      if (Date.now() - keyboardCopyAt > 1000) {
        const state = useCanvasStore.getState();
        if (!state.selection.length || (event.type === "cut" && selectReadOnly(state))) return;
        if (event.type === "cut") state.cut();
        else state.copy();
      }
      keyboardCopyAt = -Infinity;
      for (const [type, value] of Object.entries(boardClipboardData(clipboardNodes()))) event.clipboardData.setData(type, value);
      event.preventDefault();
    };
    const onPaste = (event) => {
      if (typing(event.target)) return;
      const state = useCanvasStore.getState();
      if (touchViewOnly || selectReadOnly(state)) return;
      const data = event.clipboardData;
      const files = Array.from(data?.files ?? []).filter((file) => file.type.startsWith("image/"));
      event.preventDefault();
      if (files.length) return void importImageFiles(files);
      const html = data?.getData("text/html") ?? "";
      const cells = isBoardCopy(html) ? null : clipboardCells(html, data?.getData("text/plain") ?? "");
      if (!cells) return void state.paste();
      const { added, truncated } = pasteCellsAsStickies(cells, viewCenter());
      if (truncated) notify(`Added ${added} stickies. Only the first 50 rows and 100 columns are pasted.`);
    };
    document.addEventListener("copy", onCopy);
    document.addEventListener("cut", onCopy);
    document.addEventListener("paste", onPaste);
    return () => {
      document.removeEventListener("copy", onCopy);
      document.removeEventListener("cut", onCopy);
      document.removeEventListener("paste", onPaste);
    };
  }, [importImageFiles, touchViewOnly, viewCenter, notify]);
}
