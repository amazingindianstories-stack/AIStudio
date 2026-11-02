"use client";

import { useEffect } from "react";
import { useFacilitationStore } from "./facilitation-store";
import { chimeDue, remainingMs } from "./facilitation";
import { playChime, setMusic } from "./chime";
import { pollDelay } from "./use-board-polling";

/** Facilitation polling cadence: as often as the board while visible, backing off when the tab is idle. */
const ACTIVE_MS = 3000;
const IDLE_MS = 15000;

/**
 * Keeps the open board's facilitation state fresh and plays the timer's music and chime. Everything else
 * reads the store. Mounted once by the board view.
 */
export function useFacilitation(boardId) {
  useEffect(() => {
    if (!boardId) return undefined;
    const store = useFacilitationStore.getState();
    store.open(boardId);
    let timer = null;
    let disposed = false;
    let lastInput = Date.now();
    const schedule = () => {
      clearTimeout(timer);
      if (disposed) return;
      const delay = pollDelay({ visible: document.visibilityState === "visible", idleForMs: Date.now() - lastInput });
      if (delay !== null) timer = setTimeout(run, delay >= 15000 ? IDLE_MS : ACTIVE_MS);
    };
    const run = async () => {
      await useFacilitationStore.getState().refresh();
      schedule();
    };
    const onInput = () => {
      lastInput = Date.now();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") void run();
      else clearTimeout(timer);
    };
    void run();
    window.addEventListener("pointerdown", onInput);
    window.addEventListener("keydown", onInput);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      disposed = true;
      clearTimeout(timer);
      window.removeEventListener("pointerdown", onInput);
      window.removeEventListener("keydown", onInput);
      document.removeEventListener("visibilitychange", onVisible);
      setMusic(null);
      useFacilitationStore.getState().close();
    };
  }, [boardId]);

  // One-second tick while a timer runs: ring the chime at zero, once per run, and play the music while it counts.
  useEffect(() => {
    if (!boardId) return undefined;
    const tick = () => {
      const { timer, offset, rungRun, muted, markRung } = useFacilitationStore.getState();
      const left = remainingMs(timer, offset, Date.now());
      const counting = timer?.state === "running" && left > 0;
      setMusic(counting && !muted ? timer.music : null);
      if (chimeDue(timer, offset, Date.now(), rungRun)) {
        markRung(timer.run);
        if (!muted) playChime();
      }
    };
    const interval = setInterval(tick, 500);
    return () => clearInterval(interval);
  }, [boardId]);
}
