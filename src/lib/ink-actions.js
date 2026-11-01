"use client";

import { useCanvasStore } from "./canvas-store";
import { eraseAt, inkNodeFromPoints, pressureWidth, simplifyStroke } from "./canvas/ink";
import { hiddenBoardIds } from "./canvas/culling";
import { hiddenNodeIds } from "./canvas/layers";
import { lockedIdSet } from "./canvas/locks";
import { recognizeStroke, scribbleTargets } from "./canvas/smart-draw";

// What a finished drawing gesture does to the board. Each is one board edit, so one undo step, one saved
// change per object and the board role is enforced by the store like for any other edit.

/**
 * Objects a drawing gesture may not remove: locked ones, those on layers this person hides, and those the
 * board hides (on a hidden diagram layer, or outside the diagram in Focus mode).
 */
function fixedIds(graph, { hiddenLayerIds, focusedDiagramId }) {
  const fixed = lockedIdSet(graph);
  for (const id of hiddenNodeIds(graph, hiddenLayerIds)) fixed.add(id);
  for (const id of hiddenBoardIds(graph, focusedDiagramId).nodes) fixed.add(id);
  return fixed;
}

/** Saves a pen or highlighter stroke (world points) as an `ink` node. */
export function commitStroke(points, style, zoom, pointerType = "mouse", pressures = []) {
  if (!points.length) return null;
  const simplified = simplifyStroke(points, zoom);
  const width = style.highlighter ? style.strokeWidth : pressureWidth(style.strokeWidth, pointerType, pressures);
  const node = inkNodeFromPoints(simplified, { ...style, strokeWidth: width });
  useCanvasStore.getState().addNode(node);
  return node;
}

/**
 * Smart drawing: reads the stroke and puts a recognized object on the board instead. Returns true when the
 * stroke was recognized (the caller then draws no ink), false when it should be kept as ink.
 */
export function commitSmartStroke(points, zoom) {
  const result = recognizeStroke(simplifyStroke(points, zoom));
  if (!result) return false;
  const store = useCanvasStore.getState();
  if (result.kind === "erase") {
    const fixed = fixedIds(store.history.present, store);
    const targets = new Set(scribbleTargets(store.history.present.nodes, points).filter((id) => !fixed.has(id)));
    if (!targets.size) return false;
    store.editBoard((graph) => ({
      ...graph,
      nodes: graph.nodes.filter((n) => !targets.has(n.id)),
      connectors: graph.connectors.filter((c) => !targets.has(c.from?.nodeId) && !targets.has(c.to?.nodeId)),
    }));
    store.clearSelection();
    return true;
  }
  if (result.kind === "line") {
    store.addConnector({ x: Math.round(result.from.x), y: Math.round(result.from.y) }, { x: Math.round(result.to.x), y: Math.round(result.to.y) }, "line");
    return true;
  }
  const { box } = result;
  const id = crypto.randomUUID();
  const base = { id, opacity: 1, parentId: null, groupId: null, x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.w), h: Math.round(box.h) };
  const node = result.kind === "sticky"
    ? { ...base, type: "sticky", text: "", fill: "#e3c56a", fontSize: 16, color: "#1c1a12", autoFit: true }
    : { ...base, type: result.shape, fill: "rgba(255,255,255,0.06)", stroke: "rgba(255,255,255,0.55)", strokeWidth: 2 };
  store.addNode(node);
  return true;
}

/** One step of the eraser at a world point: whole strokes, or only the touched part of each stroke when `precise`. */
export function eraseStep(point, zoom, precise) {
  const radius = (precise ? 6 : 10) / Math.max(zoom, 0.1);
  const store = useCanvasStore.getState();
  store.editBoard((graph) => eraseAt(graph, point, radius, precise, fixedIds(graph, store)), { coalesce: true });
}
