/**
 * Store actions for locking objects and for layers, spread into the board
 * store (canvas-store.js). Graph changes go through the store's
 * `mutateGraph`, so each is one undo step, saves with the per-object save
 * path, and does nothing for people who cannot edit.
 */
import { canShareRole } from "../board-access";
import { canUnlock, isLocked, lockNode, unlockNode } from "./locks";
import {
  addLayer as addLayerTo,
  assignLayer,
  deleteLayer as deleteLayerFrom,
  duplicateLayer as duplicateLayerIn,
  hiddenNodeIds,
  layersOf,
  moveLayer as moveLayerIn,
  renameLayer as renameLayerIn,
  setLayerLocked as setLayerLockedIn,
} from "./layers";
import { readHiddenLayers, writeHiddenLayers } from "./layer-visibility";

function mapNodes(present, ids, change) {
  const set = new Set(ids);
  let changed = false;
  const nodes = present.nodes.map((n) => {
    if (!set.has(n.id)) return n;
    const next = change(n);
    if (next !== n) changed = true;
    return next;
  });
  return changed ? { ...present, nodes } : present;
}

export function lockLayerActions(set, get, { mutateGraph }) {
  const edit = (compute) => {
    const before = get().history.present;
    if (compute(before) === before) return;
    mutateGraph(set, get, compute);
  };
  const hiddenOf = () => get().hiddenLayerIds;
  const keepVisibleSelection = (hidden) => {
    const gone = hiddenNodeIds(get().history.present, hidden);
    if (!gone.size) return;
    set((s) => ({ selection: s.selection.filter((id) => !gone.has(id)) }));
  };

  return {
    // Personal: the layers this person hides on the open board, and the layer new objects go on.
    hiddenLayerIds: [],
    activeLayerId: null,

    /** Locks the selected objects; `protect` makes it a protected lock when this person may set one. */
    lockSelection: (actorId, { protect = false } = {}) => {
      const { selection, boardRole } = get();
      const protectedLock = protect && canShareRole(boardRole) && actorId != null;
      edit((present) =>
        mapNodes(present, selection, (n) => {
          if (n.locked && (!protectedLock || (n.lockProtected && n.lockedBy === String(actorId)))) return n;
          if (n.locked && !canUnlock(n, actorId)) return n;
          return lockNode(n, actorId, protectedLock);
        })
      );
    },

    /** Unlocks the selected objects this person may unlock. */
    unlockSelection: (actorId) => {
      const { selection } = get();
      edit((present) => mapNodes(present, selection, (n) => (canUnlock(n, actorId) ? unlockNode(n) : n)));
    },

    /** Cmd+Shift+L: locks the selection, or unlocks it when every selected object is already locked. */
    toggleLockSelection: (actorId) => {
      const { selection, history } = get();
      if (!selection.length) return;
      const set_ = new Set(selection);
      const nodes = history.present.nodes.filter((n) => set_.has(n.id));
      if (nodes.length && nodes.every((n) => n.locked)) get().unlockSelection(actorId);
      else get().lockSelection(actorId);
    },

    /** Unlocks every object on the board this person may unlock (layer locks are lifted on the layer). */
    unlockAll: (actorId) => {
      edit((present) => {
        const ids = present.nodes.filter((n) => canUnlock(n, actorId)).map((n) => n.id);
        return mapNodes(present, ids, unlockNode);
      });
    },

    addLayer: () => {
      const id = crypto.randomUUID();
      const before = get().history.present;
      edit((present) => addLayerTo(present, id));
      if (get().history.present !== before && layersOf(get().history.present).some((l) => l.id === id)) {
        set({ activeLayerId: id });
        return id;
      }
      return null;
    },
    renameLayer: (id, name) => edit((present) => renameLayerIn(present, id, name)),
    moveLayer: (id, index) => edit((present) => moveLayerIn(present, id, index)),
    setLayerLocked: (id, locked) => edit((present) => setLayerLockedIn(present, id, locked)),
    deleteLayer: (id) => {
      const before = get().history.present;
      edit((present) => deleteLayerFrom(present, id));
      const present = get().history.present;
      if (present === before) return;
      const ids = new Set(present.nodes.map((n) => n.id));
      set((s) => ({
        activeLayerId: s.activeLayerId === id ? null : s.activeLayerId,
        selection: s.selection.filter((nodeId) => ids.has(nodeId)),
      }));
      if (hiddenOf().includes(id)) get().setLayerHidden(id, false);
    },
    duplicateLayer: (id) => {
      const layerId = crypto.randomUUID();
      edit((present) => duplicateLayerIn(present, id, layerId, () => crypto.randomUUID()));
      if (layersOf(get().history.present).some((l) => l.id === layerId)) set({ activeLayerId: layerId });
    },
    /** Puts the selected objects that are not locked on a layer (null: the default layer). */
    moveSelectionToLayer: (layerId) => {
      const { selection } = get();
      edit((present) => assignLayer(present, selection.filter((id) => !isLocked(present, id)), layerId));
      keepVisibleSelection(hiddenOf());
    },
    setActiveLayer: (id) => set({ activeLayerId: id ?? null }),

    setLayerHidden: (id, hidden) => {
      const current = hiddenOf();
      const next = hidden ? (current.includes(id) ? current : [...current, id]) : current.filter((x) => x !== id);
      if (next === current) return;
      set((s) => ({ hiddenLayerIds: next, activeLayerId: hidden && s.activeLayerId === id ? null : s.activeLayerId }));
      writeHiddenLayers(get().boardId, next);
      if (hidden) keepVisibleSelection(next);
    },
    /** Reads this person's hidden layers for the open board. */
    loadLayerVisibility: () => set({ hiddenLayerIds: readHiddenLayers(get().boardId), activeLayerId: null }),
  };
}
