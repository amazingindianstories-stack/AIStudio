/**
 * Durable copy of canvas edits the server has not acknowledged yet.
 *
 * Saves can fail, be cancelled by navigation, or exceed the browser's
 * keepalive quota. Until a PUT for exactly this content succeeds, the latest
 * edit lives in localStorage and is restored the next time the board opens.
 */

const PREFIX = "veevee-canvas-pending-v1:";
/** Browsers reject keepalive bodies above ~64 KiB; stay safely under it. */
export const KEEPALIVE_MAX_BYTES = 60 * 1024;
/** localStorage is ~5 MB per origin; never let one board evict everything else. */
const MAX_DRAFT_CHARS = 4 * 1024 * 1024;

function storage() {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function shouldUseKeepalive(body) {
  return typeof body === "string" && new TextEncoder().encode(body).length < KEEPALIVE_MAX_BYTES;
}

/**
 * `sync` records the server version the edits started from and that version's
 * graph, so a restored draft merges with what other people saved meanwhile,
 * and the id of the save sending this content, so a draft whose save landed
 * is not replayed. When the base graph does not fit, the draft keeps only its
 * version and the restore keeps the server's copy of everything both have.
 */
export function savePendingDraft(boardId, data, at = Date.now(), sync = {}) {
  const store = storage();
  if (!store || !boardId) return false;
  const { baseVersion, base, saveId } = sync;
  for (const draft of [{ at, data, baseVersion, saveId, base }, { at, data, baseVersion, saveId }]) {
    try {
      const serialized = JSON.stringify(draft);
      if (serialized.length > MAX_DRAFT_CHARS) continue;
      store.setItem(PREFIX + boardId, serialized);
      return true;
    } catch {
      /* over the browser's quota: try the smaller draft */
    }
  }
  return false;
}

export function readPendingDraft(boardId) {
  const store = storage();
  if (!store || !boardId) return null;
  try {
    const parsed = JSON.parse(store.getItem(PREFIX + boardId) || "null");
    return parsed && typeof parsed.at === "number" && parsed.data ? parsed : null;
  } catch {
    return null;
  }
}

/** Clear only if the stored draft is exactly what the server acknowledged. */
export function clearPendingDraft(boardId, acknowledgedData) {
  const store = storage();
  if (!store || !boardId) return;
  try {
    const current = readPendingDraft(boardId);
    if (!current) return;
    if (acknowledgedData === undefined || JSON.stringify(current.data) === JSON.stringify(acknowledgedData)) {
      store.removeItem(PREFIX + boardId);
    }
  } catch {
    /* best effort; a stale draft is restored and re-saved harmlessly */
  }
}
