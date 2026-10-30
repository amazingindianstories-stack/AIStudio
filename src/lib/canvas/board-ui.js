"use client";

import { create } from "zustand";

/**
 * Board UI state shared between the board's panels and overlays: which
 * finder, panel or presentation is open, what the finder highlights, and
 * what the screen reader hears next. Nothing here is saved; the board graph
 * itself stays in the canvas store.
 */

const EMPTY_HITS = { ids: [], current: null };

export const useBoardUi = create((set, get) => ({
  // One side panel at a time: "frames", "outline" or "a11y".
  panel: null,
  findOpen: false,
  paletteOpen: false,
  shortcutsOpen: false,
  // {index, grid, notes, onBoard, returnViewport} while presenting frames, else null.
  // `onBoard` is a break from the slides to look around the board.
  presenting: null,
  // Finder results: every matching object id and the one jumped to.
  findHits: EMPTY_HITS,
  // The view to return to after following a link to an object.
  goBack: null,
  // Polite live-region text; `seq` makes a repeated message speak again.
  announcement: { text: "", seq: 0 },
  // A short on-screen confirmation ("Copied as text"), also announced.
  notice: { text: "", seq: 0 },

  togglePanel: (panel) => set({ panel: get().panel === panel ? null : panel }),
  closePanel: () => set({ panel: null }),
  setFindOpen: (open) => set(open ? { findOpen: true } : { findOpen: false, findHits: EMPTY_HITS }),
  setFindHits: (hits) => set({ findHits: hits ?? EMPTY_HITS }),
  setPaletteOpen: (open) => set({ paletteOpen: open }),
  setShortcutsOpen: (open) => set({ shortcutsOpen: open }),
  setPresenting: (presenting) => set({ presenting }),
  setGoBack: (viewport) => set({ goBack: viewport }),
  announce: (text) => set({ announcement: { text, seq: get().announcement.seq + 1 } }),
  notify: (text) => {
    set({ notice: { text, seq: get().notice.seq + 1 } });
    get().announce(text);
  },

  /** Leaving a board closes everything that was about it. */
  reset: () =>
    set({ panel: null, findOpen: false, paletteOpen: false, shortcutsOpen: false, presenting: null, findHits: EMPTY_HITS, goBack: null, notice: { text: "", seq: get().notice.seq } }),
}));
