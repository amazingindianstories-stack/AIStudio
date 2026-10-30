"use client";

import { Lock, LockKeyhole, LockOpen } from "lucide-react";
import { MenuItem } from "@/components/Dropdown";
import { useStore } from "@/lib/store";
import { useCanvasStore } from "@/lib/canvas-store";
import { displayName } from "@/lib/board-access";
import { hasUnlockable, selectionLockState } from "@/lib/canvas/lock-state";
import { usePeople } from "@/lib/canvas/use-people";

function Shortcut() {
  return <span className="ml-auto pl-6 text-xs text-white/40">⌘⇧L</span>;
}

function useActorId() {
  const id = useStore((s) => s.currentUser?.id);
  return id == null ? null : String(id);
}

/** The lock state of the current selection, for the person looking. */
export function useSelectionLock() {
  const actorId = useActorId();
  const present = useCanvasStore((s) => s.history.present);
  const selection = useCanvasStore((s) => s.selection);
  const boardRole = useCanvasStore((s) => s.boardRole);
  return { actorId, ...selectionLockState(present, selection, actorId, boardRole) };
}

/** "Locked by Ana": who holds a protected lock on the selection. */
function HeldByNote({ heldBy }) {
  const people = usePeople();
  return (
    <p className="flex items-center gap-2.5 px-2.5 py-2 text-sm text-white/45" data-lock-holder="">
      <LockKeyhole className="h-4 w-4 text-amber-300/80" />
      <span className="flex-1">Locked by {displayName(people.get(heldBy), heldBy)}</span>
    </p>
  );
}

/**
 * Lock, Lock (protected) and Unlock rows for the selection, in the context
 * menu and the selection toolbar's More menu. A protected lock someone else
 * set names them and offers no Unlock.
 */
export function LockMenuItems({ onDone }) {
  const lock = useSelectionLock();
  if (!lock.count) return null;
  const run = (action) => {
    action(useCanvasStore.getState());
    onDone?.();
  };
  return (
    <>
      {lock.canLock && (
        <MenuItem label="Lock" title="Lock (⌘⇧L)" onClick={() => run((s) => s.lockSelection(lock.actorId))}>
          <Lock className="h-4 w-4 text-white/50" />
          <span className="flex-1">Lock</span>
          <Shortcut />
        </MenuItem>
      )}
      {lock.canProtect && (
        <MenuItem
          label="Lock (protected)"
          title="Only you can unlock, change or delete it"
          onClick={() => run((s) => s.lockSelection(lock.actorId, { protect: true }))}
        >
          <LockKeyhole className="h-4 w-4 text-white/50" />
          <span className="flex-1">Lock (protected)</span>
        </MenuItem>
      )}
      {lock.canUnlock && (
        <MenuItem label="Unlock" onClick={() => run((s) => s.unlockSelection(lock.actorId))}>
          <LockOpen className="h-4 w-4 text-white/50" />
          <span className="flex-1">Unlock</span>
          {!lock.canLock && <Shortcut />}
        </MenuItem>
      )}
      {lock.heldBy && <HeldByNote heldBy={lock.heldBy} />}
      {lock.onLockedLayer && !lock.canLock && !lock.canUnlock && (
        <p className="flex items-center gap-2.5 px-2.5 py-2 text-sm text-white/45">
          <Lock className="h-4 w-4 text-white/40" />
          <span className="flex-1">On a locked layer</span>
        </p>
      )}
    </>
  );
}

/** "Unlock all" on the board's background menu, when there is anything this person may unlock. */
export function UnlockAllMenuItem({ onDone }) {
  const actorId = useActorId();
  const any = useCanvasStore((s) => hasUnlockable(s.history.present, actorId));
  if (!any) return null;
  return (
    <MenuItem
      label="Unlock all"
      onClick={() => {
        useCanvasStore.getState().unlockAll(actorId);
        onDone?.();
      }}
    >
      <LockOpen className="h-4 w-4 text-white/50" />
      <span className="flex-1">Unlock all</span>
    </MenuItem>
  );
}

/**
 * The selection toolbar for objects that are all locked: style controls
 * would change nothing, so it says they are locked (and by whom, for a
 * protected lock) and offers what this person may do.
 */
export function LockedSelectionBar({ lock }) {
  const people = usePeople();
  const label = lock.heldBy
    ? `Locked by ${displayName(people.get(lock.heldBy), lock.heldBy)}`
    : lock.onLockedLayer && !lock.canUnlock
      ? "Layer locked"
      : "Locked";
  const button =
    "flex h-8 items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-white/70 outline-none hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-brand";
  return (
    <div className="flex items-center gap-1" data-locked-toolbar="">
      <span className="flex h-8 items-center gap-1.5 px-2 text-xs text-white/55">
        {lock.heldBy ? <LockKeyhole className="h-3.5 w-3.5 text-amber-300/80" /> : <Lock className="h-3.5 w-3.5" />}
        {label}
      </span>
      {lock.canUnlock && (
        <button
          type="button"
          title="Unlock (⌘⇧L)"
          onClick={() => useCanvasStore.getState().unlockSelection(lock.actorId)}
          className={button}
        >
          <LockOpen className="h-3.5 w-3.5" />
          Unlock
        </button>
      )}
      {lock.canProtect && (
        <button
          type="button"
          title="Only you can unlock, change or delete it"
          onClick={() => useCanvasStore.getState().lockSelection(lock.actorId, { protect: true })}
          className={button}
        >
          <LockKeyhole className="h-3.5 w-3.5" />
          Protect
        </button>
      )}
    </div>
  );
}
