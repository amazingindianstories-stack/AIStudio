"use client";

/**
 * Media loading for the viewer, built on the direct-storage resolver
 * (media-resolver.js) so stepping through assets costs no extra Vercel
 * invocations.
 *
 * - Every ref the viewer might need soon is resolved in one batched
 *   /api/media-resolve call, and reused from the resolver's in-memory cache.
 * - Only images and video posters near the current asset are warmed in the
 *   browser. Video masters are never prefetched: their URL is resolved (a few
 *   bytes of JSON) so the next video starts from storage directly, but the
 *   bytes only move when the user actually lands on it.
 * - The master is always what plays or displays; the small card thumbnail is
 *   only a stand-in until it has loaded.
 */
import { useEffect, useState } from "react";
import {
  cachedDirectUrl,
  forgetDirectUrl,
  isResolvable,
  mediaCacheKey,
  requestDirectUrl,
} from "./media-resolver";
import { neighbourWindow } from "./viewer-navigation";
import { thumbUrl } from "./utils";

/** Same width the grid cards request, so the browser already holds these bytes. */
export const VIEWER_THUMB_WIDTH = 480;

/** How far each side is resolved (cheap JSON) vs warmed (image bytes). */
const RESOLVE_AHEAD = 8;
const RESOLVE_BEHIND = 4;
const WARM_AHEAD = 2;
const WARM_BEHIND = 1;
/** Never hold the full-size image back longer than this waiting on a resolve. */
const RESOLVE_WAIT_MS = 2500;
const WARM_LIMIT = 16;

const MISS_TTL_MS = 60_000;

const warmed = new Map(); // url -> Image, insertion ordered so the oldest can be dropped
const misses = new Map(); // cache key -> until: refs the server answered "no direct URL" for

function isKnownMiss(ref, width) {
  const until = misses.get(mediaCacheKey(ref, width));
  return Boolean(until) && until > Date.now();
}

/**
 * requestDirectUrl, remembering a "no direct URL" answer for a minute. The
 * resolver only caches successes, so without this every arrow press would
 * re-ask for the same refs that storage cannot sign (local filesystem
 * storage, derivatives not generated yet) and cost a proxied request each.
 */
function resolveOnce(ref, width) {
  if (!isResolvable(ref) || isKnownMiss(ref, width)) return Promise.resolve(null);
  return requestDirectUrl(ref, width).then((url) => {
    if (!url) misses.set(mediaCacheKey(ref, width), Date.now() + MISS_TTL_MS);
    return url;
  });
}

function warmImage(url) {
  if (!url || typeof Image === "undefined" || warmed.has(url)) return;
  const image = new Image();
  image.decoding = "async";
  image.src = url;
  warmed.set(url, image);
  while (warmed.size > WARM_LIMIT) warmed.delete(warmed.keys().next().value);
}

/**
 * The small stand-in shown until the master is ready: the same URL the grid
 * card used (the resolver's direct thumbnail when it has one, otherwise the
 * /api/media thumbnail the browser already cached). Read-only - it never
 * triggers a resolve of its own.
 */
export function standInUrl(ref, width) {
  if (!ref) return undefined;
  const direct = isResolvable(ref) ? cachedDirectUrl(ref, width)?.url : null;
  return direct || thumbUrl(ref, width);
}

/** The refs the viewer displays for one asset, with the width each is shown at. */
export function viewerRefs(item) {
  if (!item) return [];
  if (item.kind === "image") return item.url ? [{ ref: item.url }] : [];
  const refs = [];
  if (item.url) refs.push({ ref: item.url });
  if (item.poster) refs.push({ ref: item.poster });
  return refs;
}

/**
 * Like useDirectMediaUrl, but `src` stays undefined until the resolve has
 * answered (or timed out). The viewer's element must not start on the proxied
 * URL and then restart on the direct one: for a video master that would fetch
 * the heavy bytes twice. When the neighbour preload already resolved the ref,
 * the answer is synchronous and there is no wait at all.
 */
export function useViewerMediaUrl(ref, width) {
  const key = mediaCacheKey(ref, width);
  const fallback = ref ? (width ? thumbUrl(ref, width) : ref) : undefined;
  const cachedNow = isResolvable(ref) ? cachedDirectUrl(ref, width)?.url || null : null;
  const settledNow = !isResolvable(ref) || Boolean(cachedNow) || isKnownMiss(ref, width);
  const [state, setState] = useState({ key, url: cachedNow, settled: settledNow, failed: false });
  const current = state.key === key ? state : { key, url: cachedNow, settled: settledNow, failed: false };

  useEffect(() => {
    if (!isResolvable(ref) || isKnownMiss(ref, width)) return undefined;
    const cached = cachedDirectUrl(ref, width);
    if (cached) {
      setState((prev) => (prev.key === key && prev.url === cached.url && prev.settled ? prev : { key, url: cached.url, settled: true, failed: false }));
      return undefined;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      if (!cancelled) setState((prev) => (prev.key === key && prev.settled ? prev : { key, url: null, settled: true, failed: false }));
    }, RESOLVE_WAIT_MS);
    resolveOnce(ref, width).then((url) => {
      if (cancelled) return;
      clearTimeout(timer);
      setState({ key, url: url || null, settled: true, failed: false });
    });
    return () => { cancelled = true; clearTimeout(timer); };
  }, [key, ref, width]);

  const useDirect = Boolean(current.url) && !current.failed;
  return {
    src: !ref ? undefined : useDirect ? current.url : current.settled ? fallback : undefined,
    direct: useDirect,
    /** True when it recovered by falling back to the /api/media URL. */
    onError: () => {
      if (current.url && !current.failed) {
        forgetDirectUrl(ref, width);
        setState({ key, url: current.url, settled: true, failed: true });
        return true;
      }
      return false;
    },
  };
}

/**
 * Warm the assets around the one on screen. `list` is the viewer's own list
 * (see viewer-navigation.js), so this only ever touches assets the next
 * arrow press can land on.
 */
export function useViewerPreload(list, currentId, direction) {
  useEffect(() => {
    if (!currentId) return undefined;
    const wide = neighbourWindow(list, currentId, direction, { ahead: RESOLVE_AHEAD, behind: RESOLVE_BEHIND });
    const near = neighbourWindow(list, currentId, direction, { ahead: WARM_AHEAD, behind: WARM_BEHIND });
    if (!wide.length) return undefined;
    let cancelled = false;
    // Issued in one tick so the resolver folds them into a single batch.
    const settled = wide.flatMap(viewerRefs).map(({ ref, width }) => resolveOnce(ref, width));
    Promise.all(settled).then(() => {
      if (cancelled) return;
      near.forEach((item, index) => {
        if (item.kind === "image") {
          const direct = cachedDirectUrl(item.url)?.url;
          // Without a direct URL the bytes would come through the Vercel proxy,
          // so only the very next asset in the direction of travel is warmed.
          if (direct) warmImage(direct);
          else if (index === 0) warmImage(item.url);
        } else if (item.poster) {
          const direct = cachedDirectUrl(item.poster)?.url;
          if (direct) warmImage(direct);
        }
      });
    });
    return () => { cancelled = true; };
  }, [list, currentId, direction]);
}
