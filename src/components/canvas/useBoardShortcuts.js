"use client";

import { useCallback, useEffect, useRef } from "react";
import { useCanvasStore, selectReadOnly } from "@/lib/canvas-store";
import { isCreateTool, isShapeNode } from "@/lib/canvas/shapes";
import { nodeBounds } from "@/lib/canvas/geometry";
import { dispatchShortcut } from "@/lib/canvas/shortcuts";
import { useBoardUi } from "@/lib/canvas/board-ui";
import { useBoardPrefs } from "@/lib/canvas/board-prefs";
import { dockTools } from "@/lib/canvas/toolbar-tools";
import { describeObject } from "@/lib/canvas/a11y-check";
import { selectionText, writeClipboardImage, writeClipboardText } from "@/lib/canvas/clipboard-export";
import { orderedFrames } from "@/lib/canvas/frames";
import { noteKeyboardCopy, pageTextSelected } from "@/lib/canvas/use-board-clipboard";
import { copySelectionStyle, pasteSelectionStyle } from "@/lib/canvas/sticky-actions";
import { buildDefaultNode } from "./CanvasSurface";

/** Whether the node's box is inside the visible part of the board. */
function inView(node, viewport, size) {
  const b = nodeBounds(node);
  const right = viewport.x + size.w / viewport.zoom;
  const bottom = viewport.y + size.h / viewport.zoom;
  return b.x >= viewport.x && b.y >= viewport.y && b.x + b.w <= right && b.y + b.h <= bottom;
}

/**
 * Selects `ids` from the keyboard: scrolls the view to `focusId` (default
 * the first) when it is off screen, and tells screen readers what is now
 * selected.
 */
export function selectFromKeyboard(ids, focusId = ids[0]) {
  const store = useCanvasStore.getState();
  const { present } = store.history;
  const node = present.nodes.find((n) => n.id === focusId);
  store.setSelection(ids);
  if (!node) return;
  const size = store.viewportSize();
  if (!inView(node, present.viewport, size)) {
    const b = nodeBounds(node);
    const { zoom } = present.viewport;
    store.setViewport({ x: b.x + b.w / 2 - size.w / 2 / zoom, y: b.y + b.h / 2 - size.h / 2 / zoom, zoom });
  }
  const text = ids.length > 1
    ? `${ids.length} objects selected. ${describeObject(node, present)}`
    : describeObject(node, present);
  useBoardUi.getState().announce(text);
}

/** Starts a presentation of the board's frames from the first one. */
export function startPresentation() {
  const ui = useBoardUi.getState();
  const store = useCanvasStore.getState();
  if (!orderedFrames(store.history.present).length) {
    ui.notify("Add a frame to present the board");
    return;
  }
  ui.setFindOpen(false);
  ui.setPaletteOpen(false);
  ui.setPresenting({ index: 0, grid: false, notes: false, returnViewport: ui.presenting?.returnViewport ?? store.history.present.viewport });
}

/** Copies the selection: board objects for pasting here, and their text for other apps. */
export async function copySelection() {
  const store = useCanvasStore.getState();
  if (!store.selection.length) return;
  store.copy();
  const text = selectionText(store.history.present, store.selection);
  if (text && (await writeClipboardText(text))) useBoardUi.getState().notify("Copied");
}

/**
 * The copy and cut shortcuts copy (or cut) the selected objects; the browser's
 * copy or cut event that follows puts them on the system clipboard
 * (useBoardClipboard). False when page text is selected, which the browser copies instead.
 */
function copyFromKeyboard(cut) {
  const store = useCanvasStore.getState();
  if (pageTextSelected() || !(cut ? store.cut() : store.copy())) return false;
  noteKeyboardCopy();
}

export async function copySelectionAsImage() {
  const store = useCanvasStore.getState();
  if (!store.selection.length) {
    useBoardUi.getState().notify("Select something to copy as an image");
    return;
  }
  const ok = await writeClipboardImage(store.history.present, store.selection, store.selectedConnectorIds);
  useBoardUi.getState().notify(ok ? "Copied as image" : "Could not copy as an image in this browser");
}

/**
 * The board's document-level keyboard handling, dispatched from the shortcut
 * registry. `actions` are the view's own handlers (shapes panel, image
 * picker, AI panel); they are read at key time, so they may change freely.
 * Returns `runToolbarTool(id)` for the command palette.
 */
export function useBoardShortcuts({ surfaceRef, toolLocked, touchViewOnly, openShapes, openImagePicker, toggleAi }) {
  const latest = useRef(null);
  latest.current = { surfaceRef, toolLocked, touchViewOnly, openShapes, openImagePicker, toggleAi };

  // Picks a dock tool: arms it, or opens its panel (shapes, image, AI).
  const runToolbarTool = useCallback((id) => {
    const view = latest.current;
    if (id === "shapes") view.openShapes();
    else if (id === "image") view.openImagePicker();
    else if (id === "ai") view.toggleAi();
    else useCanvasStore.getState().setTool(id);
  }, []);

  useEffect(() => {
    useBoardPrefs.getState().hydrate();
    const onKeyDown = (event) => {
      const view = latest.current;
      const ui = useBoardUi.getState();
      // A presentation owns the keyboard while a slide is up.
      if (ui.presenting && !ui.presenting.onBoard) return;
      const store = useCanvasStore.getState();
      const readOnly = selectReadOnly(store);
      const canEdit = !readOnly && !view.touchViewOnly;
      const prefs = useBoardPrefs.getState();
      const armTool = (id) => {
        useCanvasStore.getState().setTool(id);
      };
      const ctx = {
        store,
        ui,
        canEdit,
        viewOnly: view.touchViewOnly,
        singleKeys: prefs.singleKeyShortcuts,
        toolbarTools: dockTools(prefs, canEdit),
        armTool,
        runToolbarTool,
        openShapes: view.openShapes,
        openImagePicker: view.openImagePicker,
        select: (ids, focusId) => selectFromKeyboard(ids, focusId),
        focusBoard: () => view.surfaceRef.current?.focusBoard(),
        openContextMenu: () => view.surfaceRef.current?.openContextMenuAtSelection() ?? false,
        copy: () => copyFromKeyboard(false),
        cut: () => copyFromKeyboard(true),
        copyImage: () => void copySelectionAsImage(),
        copyStyle: copySelectionStyle,
        pasteStyle: pasteSelectionStyle,
        present: startPresentation,
        placeArmedTool: () => {
          if (!isCreateTool(store.tool)) return false;
          const center = view.surfaceRef.current?.getViewportCenterWorld() ?? { x: 0, y: 0 };
          const node = buildDefaultNode(store.tool, center);
          store.addNode(node);
          const next = useCanvasStore.getState();
          next.setSelection([node.id]);
          if (node.type === "text" || node.type === "sticky") next.setEditingTextId(node.id);
          if (!view.toolLocked) next.setTool("select");
        },
        editSelectedText: () => {
          if (!canEdit || store.selection.length !== 1) return false;
          const node = store.history.present.nodes.find((n) => n.id === store.selection[0]);
          if (!node || !(node.type === "text" || node.type === "sticky" || isShapeNode(node))) return false;
          store.setEditingTextId(node.id);
        },
      };
      dispatchShortcut(event, ctx);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [runToolbarTool]);

  return runToolbarTool;
}
