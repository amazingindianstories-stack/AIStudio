"use client";

import { create } from "zustand";

// Personal choice of whether the notes panel is open and whether it stays open while you work. Not board data.
const KEY = "veevee.notes-panel.v1";

function read() {
  try {
    const raw = JSON.parse(globalThis.localStorage?.getItem(KEY) ?? "null");
    return { open: raw?.open === true, pinned: raw?.pinned === true };
  } catch {
    return { open: false, pinned: false };
  }
}

function write(state) {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify({ open: state.open, pinned: state.pinned }));
  } catch {
    // Blocked storage just forgets the choice.
  }
}

export const useNotesPanel = create((set, get) => ({
  open: false,
  pinned: false,
  hydrate: () => {
    const saved = read();
    // A pinned panel reopens with the board; an unpinned one starts closed.
    set({ pinned: saved.pinned, open: saved.pinned && saved.open });
  },
  toggle: () => {
    set({ open: !get().open });
    write(get());
  },
  close: () => {
    set({ open: false });
    write(get());
  },
  setPinned: (pinned) => {
    set({ pinned });
    write(get());
  },
}));
