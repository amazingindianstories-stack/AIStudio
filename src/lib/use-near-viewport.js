"use client";

import { useEffect, useState } from "react";

/**
 * Is this element within `ROOT_MARGIN` of the viewport?
 *
 * Exists for one reason: the library feed is infinite-scroll, and every video
 * or depth card used to mount a real `<video>` element that stayed mounted for
 * the rest of the session. `content-visibility: auto` skips *rendering* an
 * off-screen card but does not unmount it, so scrolling a video-heavy library
 * accumulated one live media element per row — each holding a decoder, a
 * network connection and its buffered metadata. Browsers cap concurrent media
 * decoders (Chrome in the tens), and past that new videos silently fail to
 * load while memory keeps climbing; the tab ends up unresponsive.
 *
 * That the elements really do fetch is not a guess: the 2026-08-04 Vercel 504
 * incident (see the media-storage section of CLAUDE.md) was caused by exactly
 * these cards reading their moov atom and abandoning the connection.
 *
 * ONE SHARED OBSERVER, not one per card. A grid can hold hundreds of cards,
 * and hundreds of IntersectionObserver instances is its own cost — the
 * callbacks are looked up off the observed element instead.
 */

// 300px ≈ one card row of lead-in, so a card is mounted before it is scrolled
// to and there is no visible pop-in at normal scroll speeds.
const ROOT_MARGIN = "300px";

const callbacks = new WeakMap();
let observer = null;

function sharedObserver() {
  if (observer) return observer;
  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        callbacks.get(entry.target)?.(entry.isIntersecting);
      }
    },
    { rootMargin: ROOT_MARGIN }
  );
  return observer;
}

export function useNearViewport(ref) {
  // Starts false so a long feed mounts zero videos, then fills in what is
  // actually on screen. The observer fires immediately on observe(), so this
  // costs one extra render for visible cards rather than a visible delay.
  const [near, setNear] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // No IntersectionObserver (very old browser, or a test environment):
    // degrade to today's behaviour — always mounted — rather than to a feed
    // that never shows a video at all.
    if (typeof IntersectionObserver === "undefined") {
      setNear(true);
      return;
    }
    callbacks.set(el, setNear);
    const ob = sharedObserver();
    ob.observe(el);
    return () => {
      ob.unobserve(el);
      callbacks.delete(el);
    };
  }, [ref]);

  return near;
}
