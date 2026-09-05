import { useStore } from "./store";

/**
 * Detect main-thread stalls and record what the page looked like when one
 * happened.
 *
 * Exists because the app was reported as freezing outright — no clicks, no
 * right clicks — for real users, intermittently, and never reproduced by
 * anyone able to open a profiler at the time. The two candidate mechanisms
 * (accumulated <video> decoders in the feed, and multi-megabyte synchronous
 * localStorage writes) were both fixed by reading rather than by measurement,
 * so if it recurs there is currently no way to tell which — or neither — was
 * responsible. This turns the next occurrence into evidence.
 *
 * DRIFT, NOT requestAnimationFrame. A rAF loop runs code on every frame
 * forever to watch for a problem that happens rarely; a 1s interval that
 * measures how late it actually fired costs essentially nothing and detects
 * the same thing. A timer that should have fired at T and fires at T+6s means
 * the main thread was blocked for ~6s, which is precisely the symptom.
 *
 * Deliberately cheap enough to leave on in production: one timer per second,
 * one subtraction, and DOM counting only in the rare branch where a stall was
 * already detected.
 */

/** Report a stall when a 1s timer fires this late. Below ~2s is ordinary
 *  jank (a big paint, a GC pause) and would be noise. */
const STALL_MS = 2000;
const TICK_MS = 1000;

/** Keep the last few stalls only — this is a breadcrumb trail for a support
 *  conversation, not telemetry, and it must never itself become a leak. */
const MAX_RECORDS = 20;

const records = [];
let timer = null;
let expected = 0;
let longTasks = 0;
let longTaskObserver = null;

function snapshot(stalledMs) {
  const s = useStore.getState();
  const rec = {
    at: new Date().toISOString(),
    stalledMs: Math.round(stalledMs),
    // The hypothesis this was written to test: if the feed is accumulating
    // media elements, this number climbs through the session and is large
    // right before a freeze.
    videoElements: document.getElementsByTagName("video").length,
    domNodes: document.getElementsByTagName("*").length,
    feedItems: s.items?.length ?? 0,
    pendingItems: s.pendingItems?.length ?? 0,
    view: s.view,
    longTasksSinceLast: longTasks,
  };
  // Chrome only, and only with the right headers in some contexts — absent is
  // normal, so it is added rather than assumed.
  const mem = performance.memory;
  if (mem?.usedJSHeapSize) {
    rec.heapMB = Math.round(mem.usedJSHeapSize / 1048576);
    rec.heapLimitMB = Math.round(mem.jsHeapSizeLimit / 1048576);
  }
  longTasks = 0;
  return rec;
}

function tick() {
  const now = performance.now();
  const drift = now - expected;
  expected = now + TICK_MS;

  // A backgrounded tab has its timers throttled to about once a minute, which
  // is not a stall and would otherwise report one every time the user comes
  // back to the tab.
  if (drift > STALL_MS && !document.hidden) {
    const rec = snapshot(drift);
    records.push(rec);
    if (records.length > MAX_RECORDS) records.shift();
    console.warn(
      `[freeze-watchdog] main thread blocked ~${rec.stalledMs}ms`,
      rec,
      "— run __freezeReport() for the full history"
    );
  }
}

export function startFreezeWatchdog() {
  if (timer || typeof window === "undefined") return;
  expected = performance.now() + TICK_MS;
  timer = setInterval(tick, TICK_MS);

  // Long tasks name the *duration* of individual blocking work between ticks,
  // which separates "one 6s task" (a loop) from "hundreds of small ones"
  // (thrashing, typically GC pressure from a leak).
  try {
    longTaskObserver = new PerformanceObserver((list) => {
      longTasks += list.getEntries().length;
    });
    longTaskObserver.observe({ entryTypes: ["longtask"] });
  } catch {
    // Not supported (Safari, Firefox) — drift detection alone still works.
  }

  window.__freezeReport = () => {
    const live = snapshot(0);
    console.table(records);
    return { stalls: [...records], now: live };
  };
}

export function stopFreezeWatchdog() {
  if (timer) clearInterval(timer);
  timer = null;
  longTaskObserver?.disconnect();
  longTaskObserver = null;
}
