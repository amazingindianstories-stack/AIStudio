/**
 * What the lock controls (context menu, selection toolbar, Cmd+Shift+L)
 * offer for a selection, from the board data and who is looking. The store
 * actions in lock-layer-actions.js apply the same rules; this only decides
 * which entries to show.
 */
import { canShareRole } from "../board-access";
import { canUnlock, isLocked } from "./locks";

function selectedNodes(state, selection) {
  const ids = new Set(selection);
  return (state?.nodes ?? []).filter((n) => ids.has(n.id));
}

/**
 * - `allLocked`: every selected object is locked, by itself or by its layer.
 * - `canLock` / `canProtect`: Lock / Lock (protected) would change something.
 * - `canUnlock`: some selected object has a lock this person may lift.
 * - `heldBy`: the id of the other person whose protected lock holds a selected object.
 * - `onLockedLayer`: some selected object is locked only by its layer.
 */
export function selectionLockState(state, selection, actorId, role) {
  const nodes = selectedNodes(state, selection);
  const actor = actorId == null ? null : String(actorId);
  const mayProtect = actor != null && canShareRole(role);
  const ownProtected = (n) => n.lockProtected === true && n.lockedBy === actor;
  return {
    count: nodes.length,
    allLocked: nodes.length > 0 && nodes.every((n) => isLocked(state, n)),
    canLock: nodes.some((n) => !n.locked),
    canProtect: mayProtect && nodes.some((n) => !n.locked || (!ownProtected(n) && canUnlock(n, actor))),
    canUnlock: nodes.some((n) => canUnlock(n, actor)),
    heldBy: nodes.find((n) => n.locked && n.lockProtected === true && n.lockedBy !== actor)?.lockedBy ?? null,
    onLockedLayer: nodes.some((n) => !n.locked && isLocked(state, n)),
  };
}

/** Whether "Unlock all" would unlock anything for this person. */
export function hasUnlockable(state, actorId) {
  const actor = actorId == null ? null : String(actorId);
  return (state?.nodes ?? []).some((n) => canUnlock(n, actor));
}
