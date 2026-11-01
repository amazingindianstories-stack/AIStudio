"use client";

import { create } from "zustand";

/**
 * Each person's own board preferences (navigation, grid, overlays, motion).
 * They follow the person across boards on this device, in localStorage, since
 * there is no per-user preference store on the server; board-wide settings
 * everyone shares live in the board data instead (`settings`).
 */
const KEY = "veevee.board.viewPrefs";

// World units between grid lines; the grid drawn and snap-to-grid share it.
export const GRID_SIZE = 24;

export const DEFAULT_VIEW_PREFS = {
  // What a plain wheel or two-finger scroll does: "auto" guesses per event,
  // "mouse" zooms with the wheel, "trackpad" pans with two fingers.
  navigationMode: "auto",
  grid: "dots", // "dots" | "lines" | "none"
  snapToGrid: false,
  minimap: false,
  scrollbars: false,
  alignmentGuides: true,
  showDimensions: true,
  // Marquee and lasso pick only objects at least 90% inside the area.
  preciseSelection: false,
  // Added to the system's prefers-reduced-motion, which always applies.
  reduceMotion: false,
};

const CHOICES = {
  navigationMode: ["auto", "mouse", "trackpad"],
  grid: ["dots", "lines", "none"],
};

function sanitize(raw) {
  const prefs = { ...DEFAULT_VIEW_PREFS };
  if (!raw || typeof raw !== "object") return prefs;
  for (const key of Object.keys(DEFAULT_VIEW_PREFS)) {
    const value = raw[key];
    if (CHOICES[key] ? CHOICES[key].includes(value) : typeof value === "boolean") prefs[key] = value;
  }
  return prefs;
}

function read() {
  try {
    return sanitize(JSON.parse(window.localStorage.getItem(KEY) ?? "null"));
  } catch {
    return { ...DEFAULT_VIEW_PREFS };
  }
}

function write(prefs) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    /* storage unavailable: the choice lasts for this visit */
  }
}

export const useViewPrefs = create((set, get) => ({
  ...DEFAULT_VIEW_PREFS,
  loaded: false,
  /** Reads the saved preferences; called once when a board opens. */
  load: () => set({ ...read(), loaded: true }),
  setPref: (key, value) => {
    if (!(key in DEFAULT_VIEW_PREFS)) return;
    const next = sanitize({ ...prefsOf(get()), [key]: value });
    set(next);
    write(next);
  },
  togglePref: (key) => get().setPref(key, !get()[key]),
}));

export function prefsOf(state) {
  const prefs = {};
  for (const key of Object.keys(DEFAULT_VIEW_PREFS)) prefs[key] = state[key];
  return prefs;
}

/** True when animations should be skipped: this person's toggle, or the system setting. */
export function prefersReducedMotion() {
  if (useViewPrefs.getState().reduceMotion) return true;
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}
