/**
 * Store actions for rotating and precisely sizing objects, spread into the
 * board store (canvas-store.js). Each goes through `mutateGraph`, so it is
 * one undo step, saves with the per-object save path and does nothing for
 * people who cannot edit. Locked objects and frames (for rotation) are
 * skipped by the pure functions in transform.js.
 */
import { rotateNodesAbout, setImagesAspectLocked, setNodesRotation, setNodesSize } from "./transform";

export function transformActions(set, get, { mutateGraph }) {
  const edit = (compute) => {
    const before = get().history.present;
    if (compute(before) === before) return;
    mutateGraph(set, get, compute);
  };

  return {
    /** Turns the selection by `deltaDeg` clockwise about `center` (default: the selection's center). */
    rotateSelectionBy: (deltaDeg, center = null) => {
      const ids = get().selection;
      edit((present) => rotateNodesAbout(present, ids, deltaDeg, center));
    },

    /** Sets the rotation of the selected objects (or `ids`) to `deg`. */
    setRotation: (deg, ids = get().selection) => {
      edit((present) => setNodesRotation(present, ids, deg));
    },

    /** Sets the width and/or height of the selected objects (or `ids`), in world pixels. */
    setSize: (size, ids = get().selection) => {
      edit((present) => setNodesSize(present, ids, size));
    },

    /** Turns the aspect lock of the selected images (or `ids`) on or off. */
    setAspectLocked: (locked, ids = get().selection) => {
      edit((present) => setImagesAspectLocked(present, ids, locked));
    },
  };
}
