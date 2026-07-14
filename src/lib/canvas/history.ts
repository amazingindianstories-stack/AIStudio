/**
 * Pure undo/redo stack reducer over CanvasState snapshots ("snapshot undo",
 * not command/inverse-op — see design.md Trade-offs: far less code, cheap
 * because the blob is small structured JSON, bounded to 50 steps).
 */

export interface History<T> {
  past: T[];
  present: T;
  future: T[];
}

const CAP = 50;

/** Pushes `present` onto `past` (bounded to CAP), sets `next` as present,
 * and clears `future` (a new commit invalidates any redo branch). */
export function commit<T>(h: History<T>, next: T): History<T> {
  const past = [...h.past, h.present].slice(-CAP);
  return { past, present: next, future: [] };
}

/** Steps back one snapshot. No-op at the start of history. */
export function undo<T>(h: History<T>): History<T> {
  if (h.past.length === 0) return h;
  const previous = h.past[h.past.length - 1];
  const past = h.past.slice(0, -1);
  const future = [h.present, ...h.future];
  return { past, present: previous, future };
}

/** Steps forward one snapshot. No-op at the end of history. */
export function redo<T>(h: History<T>): History<T> {
  if (h.future.length === 0) return h;
  const next = h.future[0];
  const future = h.future.slice(1);
  const past = [...h.past, h.present];
  return { past, present: next, future };
}
