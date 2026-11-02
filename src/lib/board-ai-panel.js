// How the rest of the board asks the Create with AI panel to open (toolbar, context menu), and the per-person
// preference that turns the AI entry points off. The preference is a browser setting: the app has no per-user
// preference store the board can write to.

import { create } from "zustand";
import { useSyncExternalStore } from "react";

const PREF_KEY = "veevee.board.aiInputs";
const listeners = new Set();
let memory = null;

function readPref() {
  try {
    return window.localStorage.getItem(PREF_KEY) !== "off";
  } catch {
    return true;
  }
}

export function setAiInputs(on) {
  try {
    window.localStorage.setItem(PREF_KEY, on ? "on" : "off");
  } catch {
    // Storage can be blocked; the choice then lasts until the page reloads.
    memory = on;
  }
  for (const listener of listeners) listener();
}

const snapshot = () => (memory === null ? readPref() : memory);
const subscribe = (listener) => {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
};

/** Whether the AI entry points (toolbar button, context menu rows, dictation) show; on by default. */
export function useAiInputs() {
  return useSyncExternalStore(subscribe, snapshot, () => true);
}

/**
 * A request to open the panel, optionally with a one-click action (`{ format, prompt }`) from
 * `ai-selection.js`. `nonce` changes on every request so asking twice still opens it.
 */
export const useAiPanelIntent = create((set) => ({
  nonce: 0,
  preset: null,
  request: (preset = null) => set((state) => ({ nonce: state.nonce + 1, preset })),
  consume: () => set({ preset: null }),
}));
