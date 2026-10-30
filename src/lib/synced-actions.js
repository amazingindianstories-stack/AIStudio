"use client";

import { useCanvasStore } from "./canvas-store";
import { syncedNodeFor } from "./canvas/frames";

/** Adds a view-only synced copy of `frame` (from `listFrames`) of another board at the middle of the view. */
export function addSyncedCopy(boardId, frame) {
  const store = useCanvasStore.getState();
  const node = syncedNodeFor(boardId, frame, store.viewportCenter());
  store.addNode(node);
  return node;
}
