/** Live-feed polling decisions, kept pure so they can be tested in isolation. */

export const LIVE_MS_ACTIVE = 3000;
export const LIVE_MS_IDLE = 20000;
export const LIVE_MS_DRAIN = 250;
export const LIVE_MS_MAX_BACKOFF = 120000;
/** A job "running" for longer than this no longer justifies the fast cadence. */
export const LIVE_ACTIVE_WINDOW_MS = 30 * 60 * 1000;

/** The server's ``next`` cursor pages without gaps; ``now`` is the legacy fallback. */
export function nextLiveCursor(data, current) {
  const next = data && data.next;
  if (next && typeof next.since === "number" && Number.isFinite(next.since)) {
    return { since: next.since, afterId: typeof next.afterId === "string" ? next.afterId : null };
  }
  if (data && typeof data.now === "number") return { since: data.now, afterId: null };
  return current;
}

export function liveUpdatesUrl(cursor) {
  const params = new URLSearchParams({ since: String(cursor.since) });
  if (cursor.afterId) params.set("afterId", cursor.afterId);
  return `/api/history/updates?${params}`;
}

export function hasRecentActiveWork(items, now = Date.now()) {
  return items.some((item) => {
    if (item.status !== "queued" && item.status !== "running") return false;
    const touched = Number(item.updatedAt ?? item.createdAt);
    return !Number.isFinite(touched) || now - touched < LIVE_ACTIVE_WINDOW_MS;
  });
}

export function liveDelay({ more = false, busy = false, failures = 0 } = {}) {
  if (failures > 0) return Math.min(LIVE_MS_IDLE * 2 ** (failures - 1), LIVE_MS_MAX_BACKOFF);
  if (more) return LIVE_MS_DRAIN;
  return busy ? LIVE_MS_ACTIVE : LIVE_MS_IDLE;
}
