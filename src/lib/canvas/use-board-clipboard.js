"use client";

import { useEffect } from "react";
import { clipboardNodes, selectReadOnly, useCanvasStore } from "@/lib/canvas-store";
import { boardClipboardData, clipboardCells, isBoardCopy } from "./board-clipboard";
import { pasteCellsAsStickies } from "./sticky-actions";
import { isBoardFile } from "./media-upload";
import { looksLikeLink } from "./media-actions";

let keyboardCopyAt = -Infinity;

/** Called once the board's copy or cut shortcut copied objects, just before the browser's copy or cut event. */
export function noteKeyboardCopy() {
  keyboardCopyAt = Date.now();
}

function keyboardCopied() {
  return Date.now() - keyboardCopyAt <= 1000;
}

/** After the board's own menu copied or cut objects: puts them on the system clipboard as the shortcut does. */
export function markSystemClipboard() {
  noteKeyboardCopy();
  document.execCommand("copy");
}

/** Whether a modal dialog is open, which keeps keyboard and clipboard input away from the board behind it. */
export function modalOpen() {
  return Boolean(document.querySelector('[aria-modal="true"]'));
}

function typing(target) {
  return target?.isContentEditable || target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || modalOpen();
}

/** Page text the person selected (board objects hold no selectable text), which a copy copies instead. */
export function pageTextSelected() {
  const selection = document.getSelection();
  return Boolean(selection && !selection.isCollapsed && selection.toString());
}

/** Whether a menu copy or cut (not the shortcut) would copy board objects. */
function menuCopiesBoard(type) {
  const state = useCanvasStore.getState();
  return !pageTextSelected() && state.selection.length > 0 && !(type === "cut" && selectReadOnly(state));
}

/**
 * Board copy, cut and paste through the browser's clipboard events. Copy and
 * cut also mark the system clipboard (board-clipboard.js). A paste adds
 * image files, the board's own copied objects when they were copied last,
 * or one sticky per spreadsheet cell, centered on the view.
 */
export function useBoardClipboard({ importImageFiles, importLink, touchViewOnly, viewCenter, notify }) {
  useEffect(() => {
    // Safari only sends copy and cut without a text selection when these are cancelled.
    const onBeforeCopy = (event) => {
      if (typing(event.target)) return;
      if (keyboardCopied() || menuCopiesBoard(event.type === "beforecut" ? "cut" : "copy")) event.preventDefault();
    };
    const onCopy = (event) => {
      if (typing(event.target) || !event.clipboardData) return;
      // The shortcut already copied (and for cut, deleted); a menu copy or cut copies here.
      if (!keyboardCopied()) {
        if (!menuCopiesBoard(event.type)) return;
        const state = useCanvasStore.getState();
        if (event.type === "cut") state.cut();
        else state.copy();
      }
      keyboardCopyAt = -Infinity;
      const data = boardClipboardData(clipboardNodes(), useCanvasStore.getState().visibleBoard());
      for (const [type, value] of Object.entries(data)) event.clipboardData.setData(type, value);
      event.preventDefault();
    };
    const onPaste = (event) => {
      if (typing(event.target)) return;
      const state = useCanvasStore.getState();
      if (touchViewOnly || selectReadOnly(state)) return;
      const data = event.clipboardData;
      const files = Array.from(data?.files ?? []).filter(isBoardFile);
      event.preventDefault();
      if (files.length) return void importImageFiles(files);
      const html = data?.getData("text/html") ?? "";
      if (isBoardCopy(html)) return void state.paste();
      const text = (data?.getData("text/plain") ?? "").trim();
      if (importLink && looksLikeLink(text)) {
        importLink(text).catch((error) => notify(error.message || "Could not add the link."));
        return;
      }
      const cells = clipboardCells(html, data?.getData("text/plain") ?? "");
      if (!cells) return void state.paste();
      const { added, truncated } = pasteCellsAsStickies(cells, viewCenter());
      if (truncated) notify(`Added ${added} stickies. Only the first 50 rows and 100 columns are pasted.`);
    };
    document.addEventListener("beforecopy", onBeforeCopy);
    document.addEventListener("beforecut", onBeforeCopy);
    document.addEventListener("copy", onCopy);
    document.addEventListener("cut", onCopy);
    document.addEventListener("paste", onPaste);
    return () => {
      document.removeEventListener("beforecopy", onBeforeCopy);
      document.removeEventListener("beforecut", onBeforeCopy);
      document.removeEventListener("copy", onCopy);
      document.removeEventListener("cut", onCopy);
      document.removeEventListener("paste", onPaste);
    };
  }, [importImageFiles, importLink, touchViewOnly, viewCenter, notify]);
}
