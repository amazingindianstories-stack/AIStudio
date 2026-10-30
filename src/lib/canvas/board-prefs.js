"use client";

import { create } from "zustand";

/**
 * Personal board preferences: what one person likes, on this browser, for
 * every board. Board-wide settings everyone shares live in the board data
 * instead. There is no server-side user preference store, so these stay in
 * localStorage and fall back to the defaults when it is unavailable.
 */

const KEY = "veevee-board-prefs-v1";

export const DEFAULT_PREFS = {
  // Off: single-character shortcuts (V, N, 1-9, ?...) never fire, so screen
  // readers and voice control keep those keys.
  singleKeyShortcuts: true,
  // The creation toolbar's tool ids in the person's order; tools missing
  // from the list keep their default place after the listed ones.
  toolbarOrder: [],
  // Creation tools unpinned from the toolbar (still reachable from its menu).
  toolbarHidden: [],
  // Boards this person opened lately, newest first: {id, projectId, name}.
  recentBoards: [],
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
    recentBoards: recentBoards(value.recentBoards),
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

  /** Puts a just-opened board first in the recent boards. */
  rememberBoard: (board) => {
    get().hydrate();
    const rest = get().recentBoards.filter((b) => b.id !== board.id);
    get().setPrefs({ recentBoards: [board, ...rest] });
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
    recentBoards: state.recentBoards,
  };
}
