"use client";

import { useEffect, useState } from "react";

/**
 * Full-screen mode for the board, with the browser Fullscreen API. It
 * expands the whole page rather than one element: menus, dialogs and notices
 * render into the document body, which an element in full screen would hide.
 * Leaving the board (CanvasView unmounting) leaves full screen too.
 */
export function fullscreenSupported() {
  return typeof document !== "undefined" && Boolean(document.fullscreenEnabled && document.documentElement.requestFullscreen);
}

export function isFullscreen() {
  return typeof document !== "undefined" && Boolean(document.fullscreenElement);
}

export async function enterFullscreen() {
  if (!fullscreenSupported() || isFullscreen()) return;
  try {
    await document.documentElement.requestFullscreen({ navigationUI: "hide" });
  } catch {
    /* refused (no user gesture, or blocked by the browser): stay windowed */
  }
}

export async function exitFullscreen() {
  if (!isFullscreen()) return;
  try {
    await document.exitFullscreen();
  } catch {
    /* already left */
  }
}

export function toggleFullscreen() {
  return isFullscreen() ? exitFullscreen() : enterFullscreen();
}

/** Whether the page is in full screen, kept current through fullscreenchange (Esc included). */
export function useFullscreen() {
  const [active, setActive] = useState(false);
  useEffect(() => {
    const sync = () => setActive(isFullscreen());
    sync();
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);
  return active;
}
