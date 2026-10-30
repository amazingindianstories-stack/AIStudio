"use client";

import { create } from "zustand";

/**
 * Personal board preferences: what one person likes, on this browser, for
 * every board. Board-wide settings everyone shares live in the board data
 * instead. There is no server-side user preference store, so these stay in
 * localStorage and fall back to the defaults when it is unavailable.
 *
 * The toolbar and shortcut prefs belong to the device. Recent boards name
 * boards, so they are kept per account and cleared on sign-out.
 */

const KEY = "veevee-board-prefs-v1";
const recentKey = (userId) => `${KEY}:${userId}`;

export const DEFAULT_PREFS = {
  // Off: single-character shortcuts (V, N, 1-9, ?...) never fire, so screen
  // readers and voice control keep those keys.
  singleKeyShortcuts: true,
  // The creation toolbar's tool ids in the person's order; tools missing
  // from the list keep their default place after the listed ones.
  toolbarOrder: [],
  // Creation tools unpinned from the toolbar (still reachable from its menu).
  toolbarHidden: [],
};

export const MAX_RECENT_BOARDS = 8;

function storage() {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function recentBoards(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((b) => b && typeof b.id === "string" && typeof b.projectId === "string")
    .map((b) => ({ id: b.id, projectId: b.projectId, name: typeof b.name === "string" ? b.name.slice(0, 200) : "" }))
    .slice(0, MAX_RECENT_BOARDS);
}

const ids = (value) => (Array.isArray(value) ? value.filter((id) => typeof id === "string").slice(0, 64) : []);

/** Coerces stored JSON to valid prefs; anything unknown falls back to the default. */
export function parsePrefs(raw) {
  const value = raw && typeof raw === "object" ? raw : {};
  return {
    singleKeyShortcuts: value.singleKeyShortcuts !== false,
    toolbarOrder: ids(value.toolbarOrder),
    toolbarHidden: ids(value.toolbarHidden),
  };
}

function readPrefs() {
  try {
    const raw = storage()?.getItem(KEY);
    return raw ? parsePrefs(JSON.parse(raw)) : { ...DEFAULT_PREFS };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

function writePrefs(prefs) {
  try {
    storage()?.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // Full or blocked storage: the preference lasts for this session only.
  }
}

export const useBoardPrefs = create((set, get) => ({
  ...DEFAULT_PREFS,
  hydrated: false,

  /** Reads the saved prefs once on the client (not at import, so server rendering matches). */
  hydrate: () => {
    if (get().hydrated) return;
    set({ ...readPrefs(), hydrated: true });
  },

  setPrefs: (patch) => {
    // Never write over saved prefs that have not been read yet.
    get().hydrate();
    const next = parsePrefs({ ...pick(get()), ...patch });
    set(next);
    writePrefs(next);
  },
}));

function pick(state) {
  return {
    singleKeyShortcuts: state.singleKeyShortcuts,
    toolbarOrder: state.toolbarOrder,
    toolbarHidden: state.toolbarHidden,
  };
}

/** The boards `userId` opened lately on this browser, newest first: {id, projectId, name}. */
export function readRecentBoards(userId) {
  if (!userId) return [];
  try {
    const raw = storage()?.getItem(recentKey(userId));
    return raw ? recentBoards(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

/** Puts a just-opened board first in `userId`'s recent boards. */
export function rememberBoard(userId, board) {
  if (!userId) return;
  const next = recentBoards([board, ...readRecentBoards(userId).filter((b) => b.id !== board.id)]);
  try {
    storage()?.setItem(recentKey(userId), JSON.stringify(next));
  } catch {
    // Full or blocked storage: the board is just not listed as recent.
  }
}

/** Forgets `userId`'s recent boards on this browser, for sign-out. */
export function clearRecentBoards(userId) {
  if (!userId) return;
  try {
    storage()?.removeItem(recentKey(userId));
  } catch {
    // Blocked storage never held any.
  }
}
