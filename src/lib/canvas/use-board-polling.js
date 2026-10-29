"use client";

import { useEffect } from "react";

/**
 * How often an open board asks whether someone else saved. Each poll is one
 * tiny version read, so about 50 people on active boards cost about 17
 * requests a second; idle and hidden tabs back off so the cost tracks real
 * collaboration rather than the number of open tabs.
 */
export const ACTIVE_POLL_MS = 3000;
export const IDLE_POLL_MS = 15000;
/** No input from this person and no change from anyone else for this long. */
export const IDLE_AFTER_MS = 60000;

/** Milliseconds until the next poll, or null to stop until the tab is visible again. */
export function pollDelay({ visible, idleForMs }) {
  if (!visible) return null;
  return idleForMs >= IDLE_AFTER_MS ? IDLE_POLL_MS : ACTIVE_POLL_MS;
}

const ACTIVITY_EVENTS = ["pointerdown", "keydown", "wheel"];

/** Polls `poll` (resolving true when it merged someone else's change) while `boardId` is open. */
export function useBoardPolling(boardId, poll) {
  useEffect(() => {
    if (!boardId) return undefined;
    let timer = null;
    let lastActivity = Date.now();
    let disposed = false;

    const schedule = () => {
      clearTimeout(timer);
      timer = null;
      if (disposed) return;
      const delay = pollDelay({ visible: document.visibilityState === "visible", idleForMs: Date.now() - lastActivity });
      if (delay !== null) timer = setTimeout(run, delay);
    };
    const run = async () => {
      // Someone else editing keeps the cadence active even while this person only watches.
      if (await poll()) lastActivity = Date.now();
      schedule();
    };
    const onActivity = () => {
      const wasIdle = Date.now() - lastActivity >= IDLE_AFTER_MS;
      lastActivity = Date.now();
      if (wasIdle) void run();
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        lastActivity = Date.now();
        void run();
      } else {
        schedule();
      }
    };

    schedule();
    document.addEventListener("visibilitychange", onVisibility);
    for (const name of ACTIVITY_EVENTS) window.addEventListener(name, onActivity, { capture: true, passive: true });
    return () => {
      disposed = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      for (const name of ACTIVITY_EVENTS) window.removeEventListener(name, onActivity, { capture: true });
    };
  }, [boardId, poll]);
}
