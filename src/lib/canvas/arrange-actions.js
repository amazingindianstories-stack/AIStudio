/**
 * Store actions for arranging objects (align, distribute, auto layout, smart
 * duplicate, filter selection, clear content), spread into the board store
 * (canvas-store.js). Each change is one `mutateGraph` call, so it is one undo
 * step, saves through the per-object save path, and does nothing for people
 * who cannot edit. Locked objects are skipped (see arrange.js).
 */
import { nodeBounds, unionBounds } from "./geometry";
import { lockedIdSet } from "./locks";
import {
  alignDeltas,
  applyDeltas,
  autoLayoutDeltas,
  clearedNode,
  distributeDeltas,
  duplicateOffset,
  idsOfKind,
} from "./arrange";

export function arrangeActions(set, get, { mutateGraph, buildClones, readOnly }) {
  const moveBy = (computeDeltas) => {
    const { selection, history } = get();
    if (readOnly(get()) || selection.length < 2) return;
    if (!computeDeltas(history.present, selection).size) return;
    mutateGraph(set, get, (present) => applyDeltas(present, computeDeltas(present, selection)));
  };

  return {
    /** Lines the selection up: "left" | "hcenter" | "right" | "top" | "vcenter" | "bottom". */
    alignSelection: (mode) => moveBy((present, ids) => alignDeltas(present, ids, mode)),

    /** Spaces 3+ selected objects evenly along "x" (horizontally) or "y" (vertically). */
    distributeSelection: (axis) => moveBy((present, ids) => distributeDeltas(present, ids, axis)),

    /** Lays the selection out in one row ("x") or column ("y") with `gap` between objects. */
    autoLayoutSelection: (axis, gap) => moveBy((present, ids) => autoLayoutDeltas(present, ids, axis, gap)),

    /**
     * Alt+Arrow: copies the selection to the side in `direction` ("left" |
     * "right" | "up" | "down"), a gap beyond its bounds, and selects the copies.
     */
    duplicateSelectionToward: (direction) => {
      const { selection, history } = get();
      if (readOnly(get()) || !selection.length) return;
      const wanted = new Set(selection);
      const bounds = unionBounds(history.present.nodes.filter((n) => wanted.has(n.id)).map(nodeBounds));
      if (!bounds) return;
      const { dx, dy } = duplicateOffset(bounds, direction);
      let idMap = new Map();
      mutateGraph(set, get, (present) => {
        const built = buildClones(present.nodes, selection, dx, dy, true);
        idMap = built.idMap;
        return { ...present, nodes: [...present.nodes, ...built.clones] };
      });
      if (idMap.size) set({ selection: Array.from(idMap.values()), selectedConnectorIds: [] });
    },

    /** Narrows the selection to one object kind (see arrange.kindOf). */
    filterSelectionByKind: (kind) => {
      const { selection, history } = get();
      const ids = idsOfKind(history.present, selection, kind);
      if (ids.length) set({ selection: ids, selectedConnectorIds: [] });
    },

    /** Empties the text of the selected sticky notes, text boxes and shapes, keeping their style. */
    clearSelectedContent: () => {
      const { selection, history } = get();
      if (readOnly(get()) || !selection.length) return;
      const clear = (present) => {
        const locked = lockedIdSet(present);
        const wanted = new Set(selection.filter((id) => !locked.has(id)));
        let changed = false;
        const nodes = present.nodes.map((n) => {
          if (!wanted.has(n.id)) return n;
          const next = clearedNode(n);
          if (next !== n) changed = true;
          return next;
        });
        return changed ? { ...present, nodes } : present;
      };
      if (clear(history.present) === history.present) return;
      if (get().editingTextId && selection.includes(get().editingTextId)) set({ editingTextId: null });
      mutateGraph(set, get, clear);
    },
  };
}
