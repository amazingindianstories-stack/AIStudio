/**
 * Pure array-reorder helpers for the canvas board. Z-order IS array index
 * (index 0 = back, last = front) — no explicit `z` field (design.md
 * Trade-offs). All four operate on `CanvasState.nodes` copies.
 */
import type { CanvasNode } from "./types";

/** Moves the selected ids to the end of the array (front), preserving their
 * relative order among themselves and the relative order of the rest. */
export function bringToFront(nodes: CanvasNode[], ids: string[]): CanvasNode[] {
  const idSet = new Set(ids);
  const selected = nodes.filter((n) => idSet.has(n.id));
  const rest = nodes.filter((n) => !idSet.has(n.id));
  return [...rest, ...selected];
}

/** Moves the selected ids to the start of the array (back), preserving their
 * relative order among themselves and the relative order of the rest. */
export function sendToBack(nodes: CanvasNode[], ids: string[]): CanvasNode[] {
  const idSet = new Set(ids);
  const selected = nodes.filter((n) => idSet.has(n.id));
  const rest = nodes.filter((n) => !idSet.has(n.id));
  return [...selected, ...rest];
}

/** Moves each selected node one step toward the front (swaps with its next
 * neighbor), skipping when the neighbor is also selected so a selected run
 * doesn't shuffle past itself. Processed back-to-front so each node moves
 * exactly one step per call. */
export function bringForward(nodes: CanvasNode[], ids: string[]): CanvasNode[] {
  const idSet = new Set(ids);
  const arr = nodes.slice();
  for (let i = arr.length - 2; i >= 0; i--) {
    if (idSet.has(arr[i].id) && !idSet.has(arr[i + 1].id)) {
      [arr[i], arr[i + 1]] = [arr[i + 1], arr[i]];
    }
  }
  return arr;
}

/** Moves each selected node one step toward the back (swaps with its
 * previous neighbor), mirroring bringForward front-to-back. */
export function sendBackward(nodes: CanvasNode[], ids: string[]): CanvasNode[] {
  const idSet = new Set(ids);
  const arr = nodes.slice();
  for (let i = 1; i < arr.length; i++) {
    if (idSet.has(arr[i].id) && !idSet.has(arr[i - 1].id)) {
      [arr[i], arr[i - 1]] = [arr[i - 1], arr[i]];
    }
  }
  return arr;
}
