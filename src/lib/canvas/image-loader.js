/**
 * Priority-queued concurrency limiter for canvas board image loading.
 *
 * Thumbnails (256/512/1280 WebP) run with higher parallelism over HTTP/2 while
 * full-resolution masters (tier === null) use a small separate pool so large
 * 20-50 MB originals never starve visible thumbnails.
 *
 * Ordering:
 *   1. Visible inside viewport before overscan prefetch
 *   2. Initial paint (blank placeholder) before resolution upgrade
 *   3. Smaller tier before larger tier
 *   4. Closer to viewport center first
 */

import { tierRank } from "./image-lod";

export const MAX_CONCURRENT_THUMB_LOADS = 16;
export const MAX_CONCURRENT_FULL_LOADS = 2;

const pools = {
  thumb: { limit: MAX_CONCURRENT_THUMB_LOADS, active: 0, waiting: [] },
  full: { limit: MAX_CONCURRENT_FULL_LOADS, active: 0, waiting: [] },
};

function poolFor(tier) {
  return tier === null ? pools.full : pools.thumb;
}

function compareEntries(a, b) {
  if (a.inViewport !== b.inViewport) return a.inViewport ? -1 : 1;
  if (a.isUpgrade !== b.isUpgrade) return a.isUpgrade ? 1 : -1;
  const rankDiff = tierRank(a.tier) - tierRank(b.tier);
  if (rankDiff !== 0) return rankDiff;
  return a.distanceSq - b.distanceSq;
}

function drain(pool) {
  while (pool.active < pool.limit && pool.waiting.length > 0) {
    let bestIndex = 0;
    for (let i = 1; i < pool.waiting.length; i += 1) {
      if (compareEntries(pool.waiting[i], pool.waiting[bestIndex]) < 0) {
        bestIndex = i;
      }
    }
    const [entry] = pool.waiting.splice(bestIndex, 1);
    entry.start();
  }
}

/**
 * Request a load slot for one canvas image. Returns `{ acquired, updatePriority, cancel }`.
 */
export function requestCanvasImageSlot({
  tier = 512,
  inViewport = true,
  isUpgrade = false,
  distanceSq = 0,
} = {}) {
  const pool = poolFor(tier);
  let activeRelease = null;
  let entry = null;

  const acquired = new Promise((resolve) => {
    entry = {
      tier,
      inViewport: Boolean(inViewport),
      isUpgrade: Boolean(isUpgrade),
      distanceSq: Number.isFinite(distanceSq) ? distanceSq : 0,
      start: () => {
        entry = null;
        pool.active += 1;
        let released = false;
        activeRelease = () => {
          if (released) return;
          released = true;
          activeRelease = null;
          pool.active = Math.max(0, pool.active - 1);
          drain(pool);
        };
        resolve(activeRelease);
      },
    };

    if (pool.active < pool.limit) {
      entry.start();
    } else {
      pool.waiting.push(entry);
    }
  });

  return {
    acquired,
    updatePriority: (patch) => {
      if (!entry) return;
      if (patch.inViewport !== undefined) entry.inViewport = Boolean(patch.inViewport);
      if (patch.isUpgrade !== undefined) entry.isUpgrade = Boolean(patch.isUpgrade);
      if (patch.distanceSq !== undefined && Number.isFinite(patch.distanceSq)) {
        entry.distanceSq = patch.distanceSq;
      }
    },
    cancel: () => {
      if (entry) {
        const index = pool.waiting.indexOf(entry);
        if (index >= 0) pool.waiting.splice(index, 1);
        entry = null;
      }
      activeRelease?.();
    },
  };
}

/** Test seam. */
export function __resetCanvasImageLoader() {
  pools.thumb.active = 0;
  pools.thumb.waiting.length = 0;
  pools.full.active = 0;
  pools.full.waiting.length = 0;
}
