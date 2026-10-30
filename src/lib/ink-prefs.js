"use client";

import { create } from "zustand";
import { HIGHLIGHTER_COLORS, HIGHLIGHTER_WIDTHS, PEN_COLORS, PEN_WIDTHS } from "./canvas/ink";

// Personal drawing preferences: which preset the pen and highlighter use, how the eraser works and whether
// smart drawing is on. They belong to the person, not the board, so they live in this browser only.
const KEY = "veevee.ink-prefs.v1";

const DEFAULTS = { penColor: 0, penWidth: 1, highlighterColor: 0, highlighterWidth: 1, preciseEraser: false, smartDraw: false };

function clampIndex(value, length, fallback) {
  return Number.isInteger(value) && value >= 0 && value < length ? value : fallback;
}

export function normalizeInkPrefs(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  return {
    penColor: clampIndex(r.penColor, PEN_COLORS.length, DEFAULTS.penColor),
    penWidth: clampIndex(r.penWidth, PEN_WIDTHS.length, DEFAULTS.penWidth),
    highlighterColor: clampIndex(r.highlighterColor, HIGHLIGHTER_COLORS.length, DEFAULTS.highlighterColor),
    highlighterWidth: clampIndex(r.highlighterWidth, HIGHLIGHTER_WIDTHS.length, DEFAULTS.highlighterWidth),
    preciseEraser: r.preciseEraser === true,
    smartDraw: r.smartDraw === true,
  };
}

function read() {
  try {
    return normalizeInkPrefs(JSON.parse(globalThis.localStorage?.getItem(KEY) ?? "null"));
  } catch {
    return { ...DEFAULTS };
  }
}

function write(prefs) {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // Private windows and blocked storage just forget the choice.
  }
}

/** The stroke style a tool draws with: `{ stroke, strokeWidth, highlighter? }`. */
export function inkStyleFor(tool, prefs) {
  if (tool === "highlighter") {
    return { stroke: HIGHLIGHTER_COLORS[prefs.highlighterColor], strokeWidth: HIGHLIGHTER_WIDTHS[prefs.highlighterWidth], highlighter: true };
  }
  return { stroke: PEN_COLORS[prefs.penColor], strokeWidth: PEN_WIDTHS[prefs.penWidth] };
}

export const INK_TOOLS = ["pen", "highlighter", "eraser"];

export const useInkPrefs = create((set, get) => ({
  ...DEFAULTS,
  hydrated: false,
  hydrate: () => {
    if (!get().hydrated) set({ ...read(), hydrated: true });
  },
  setPref: (patch) => {
    const next = normalizeInkPrefs({ ...get(), ...patch });
    set(next);
    write(next);
  },
}));
