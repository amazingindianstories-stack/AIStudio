"use client";

import { useCanvasStore } from "./canvas-store";
import { applyFramePreset, frameAroundSelection } from "./canvas/frames";
import { canShareRole } from "./board-access";

// Frame commands. Each is one board edit through the store (one undo step, one saved change per object).

/** Hiding frames is for co-owners and owners; the server enforces it too. */
export function canHideFrames(role) {
  return canShareRole(role);
}

/** Wraps the selected objects in a new frame and selects the frame. Returns whether a frame was made. */
export function frameSelection() {
  const store = useCanvasStore.getState();
  const { selection } = store;
  if (!selection.length) return false;
  let frameId = null;
  store.editBoard((graph) => {
    const made = frameAroundSelection(graph, selection);
    if (!made) return graph;
    frameId = made.frameId;
    return made.state;
  });
  if (!frameId) return false;
  store.setSelection([frameId]);
  return true;
}

/** Resizes a frame to a preset size, keeping its top-left corner. */
export function setFramePreset(id, preset) {
  useCanvasStore.getState().editBoard((graph) => ({
    ...graph,
    nodes: graph.nodes.map((n) => (n.id === id && n.type === "frame" ? applyFramePreset(n, preset) : n)),
  }));
}

/** Hides a frame's content from everyone who cannot manage hidden frames, or reveals it again. */
export function setFrameHidden(id, hidden) {
  useCanvasStore.getState().editBoard((graph) => ({
    ...graph,
    nodes: graph.nodes.map((n) => {
      if (n.id !== id || n.type !== "frame") return n;
      if (hidden) return { ...n, hidden: true };
      const { hidden: _hidden, ...rest } = n;
      return rest;
    }),
  }));
}
