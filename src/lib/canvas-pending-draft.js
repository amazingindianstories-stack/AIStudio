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
/**
 * The server keeps applied save ids for 30 days. An older draft can no longer
 * tell whether its save landed, so it restores as if it had no base.
 */
export const DRAFT_SYNC_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

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
 * and `save` ({id, data}), the latest save attempt whose outcome is unknown,
 * so a restore can ask whether it landed instead of replaying it. A draft that
 * is itself that attempt stores only `save.id`.
 *
 * Drafts are never swept by age. When the browser's storage is full, other
 * boards' drafts are evicted, oldest first, until this one fits; if it still
 * does not, the draft keeps only its version (and the id of a save of exactly
 * this content), and the restore keeps the server's copy of everything both have.
 */
export function savePendingDraft(boardId, data, at = Date.now(), sync = {}) {
  const store = storage();
  if (!store || !boardId) return false;
  const key = PREFIX + boardId;
  const { baseVersion, base, save } = sync;
  const ownSave = save && save.data === data ? { id: save.id } : undefined;
  let evictable = null;
  try {
    for (const draft of [{ at, data, baseVersion, base, save: ownSave ?? save }, { at, data, baseVersion, save: ownSave }]) {
      const serialized = JSON.stringify(draft);
      if (serialized.length > MAX_DRAFT_CHARS) continue;
      for (;;) {
        try {
          store.setItem(key, serialized);
          return true;
        } catch (error) {
          if (!isQuotaError(error)) break;
        }
        evictable ??= otherDraftsOldestFirst(store, key);
        if (!evictable.length) break;
        store.removeItem(evictable.shift());
      }
    }
  } catch {
    /* storage unavailable: the edit stays in memory and the next save retries */
  }
  return false;
}

function isQuotaError(error) {
  return error?.name === "QuotaExceededError" || error?.name === "NS_ERROR_DOM_QUOTA_REACHED";
}

function otherDraftsOldestFirst(store, key) {
  const drafts = [];
  for (let index = 0; index < store.length; index += 1) {
    const other = store.key(index);
    if (other?.startsWith(PREFIX) && other !== key) {
      let at = 0;
      try { at = Number(JSON.parse(store.getItem(other))?.at) || 0; } catch { /* unreadable: evict first */ }
      drafts.push({ key: other, at });
    }
  }
  return drafts.sort((a, b) => a.at - b.at).map((draft) => draft.key);
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
