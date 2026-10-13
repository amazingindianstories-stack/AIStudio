"use client";

/**
 * Direct storage URLs for authorized media.
 *
 * Cards render the authorized /api/media URL first (always correct), then swap
 * to a short-lived signed storage URL resolved in batches by Django. Media bytes
 * then skip the Vercel middleware and the Django redirect entirely. Signed URLs
 * are bearer capabilities: they live only in this in-memory cache.
 */
import { useEffect, useState } from "react";
import { apiFetch } from "./api";
import { thumbUrl } from "./utils";

const BATCH_LIMIT = 100;
const BATCH_DELAY_MS = 16;
const REFRESH_MARGIN_MS = 30_000;
const DISABLE_AFTER_FAILURE_MS = 5 * 60_000;
const CACHE_LIMIT = 1000;

const cache = new Map(); // key -> { url, expiresAt }
const waiting = new Map(); // key -> [resolve]
let queue = [];
let timer = null;
let disabledUntil = 0;
let fetchImpl = (path, options) => apiFetch(path, options);

export function mediaCacheKey(ref, width) {
  return `${ref}|${width || 0}`;
}

export function isResolvable(ref) {
  return typeof ref === "string" && ref.startsWith("/api/media/");
}

export function cachedDirectUrl(ref, width, now = Date.now()) {
  const entry = cache.get(mediaCacheKey(ref, width));
  return entry && entry.url && entry.expiresAt - now > REFRESH_MARGIN_MS ? entry : null;
}

export function forgetDirectUrl(ref, width) {
  cache.delete(mediaCacheKey(ref, width));
}

function remember(key, value) {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
}

function settle(key, url) {
  const resolvers = waiting.get(key) || [];
  waiting.delete(key);
  for (const resolve of resolvers) resolve(url);
}

async function flush() {
  timer = null;
  const batch = queue.splice(0, BATCH_LIMIT);
  if (queue.length) timer = setTimeout(flush, 0);
  if (!batch.length) return;
  try {
    const response = await fetchImpl("/api/media-resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: batch.map(({ ref, width }) => ({ ref, width: width || null })) }),
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`resolve ${response.status}`);
    const data = await response.json();
    (data.items || []).forEach((item, index) => {
      const { ref, width } = batch[index] || {};
      if (!ref) return;
      const key = mediaCacheKey(ref, width);
      if (item && item.url && typeof item.expiresAt === "number") {
        remember(key, { url: item.url, expiresAt: item.expiresAt });
        settle(key, item.url);
      } else {
        settle(key, null);
      }
    });
    for (const { ref, width } of batch) if (waiting.has(mediaCacheKey(ref, width))) settle(mediaCacheKey(ref, width), null);
  } catch {
    // Older backends or transient failures: keep using /api/media for a while.
    disabledUntil = Date.now() + DISABLE_AFTER_FAILURE_MS;
    for (const { ref, width } of batch) settle(mediaCacheKey(ref, width), null);
  }
}

/** Resolve one reference; concurrent callers share a single batched request. */
export function requestDirectUrl(ref, width) {
  if (!isResolvable(ref) || Date.now() < disabledUntil) return Promise.resolve(null);
  const cached = cachedDirectUrl(ref, width);
  if (cached) return Promise.resolve(cached.url);
  const key = mediaCacheKey(ref, width);
  return new Promise((resolve) => {
    if (waiting.has(key)) {
      waiting.get(key).push(resolve);
      return;
    }
    waiting.set(key, [resolve]);
    queue.push({ ref, width });
    if (!timer) timer = setTimeout(flush, queue.length >= BATCH_LIMIT ? 0 : BATCH_DELAY_MS);
  });
}

/**
 * Returns { src, onError } for an <img>/<video>. ``width`` requests a display
 * derivative (thumbnails); omit it for the original (videos, downloads).
 */
export function useDirectMediaUrl(ref, width) {
  const fallback = width ? thumbUrl(ref, width) : ref;
  const [direct, setDirect] = useState(() => (isResolvable(ref) ? cachedDirectUrl(ref, width)?.url || null : null));
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
    if (!isResolvable(ref)) { setDirect(null); return undefined; }
    let cancelled = false;
    let refresh = null;
    const load = () => {
      requestDirectUrl(ref, width).then((url) => {
        if (cancelled) return;
        setDirect(url);
        const entry = cachedDirectUrl(ref, width);
        if (entry) refresh = setTimeout(load, Math.max(1000, entry.expiresAt - Date.now() - REFRESH_MARGIN_MS));
      });
    };
    load();
    return () => { cancelled = true; clearTimeout(refresh); };
  }, [ref, width]);
  return {
    src: !failed && direct ? direct : fallback,
    /** Returns true when it recovered by falling back to the /api/media URL. */
    onError: () => {
      if (direct && !failed) {
        forgetDirectUrl(ref, width);
        setFailed(true);
        return true;
      }
      return false;
    },
  };
}

/** Test seam. */
export function __setMediaResolverFetch(next) {
  fetchImpl = next;
  cache.clear();
  waiting.clear();
  queue = [];
  disabledUntil = 0;
  if (timer) clearTimeout(timer);
  timer = null;
}
