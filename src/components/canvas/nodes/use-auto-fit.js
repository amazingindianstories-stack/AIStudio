"use client";

import { useCallback, useEffect, useLayoutEffect } from "react";

export const AUTO_FIT_MIN = 8;

/** The largest whole size in [min, max] that `fits`, else min (fits is monotonic: smaller always fits better). */
export function largestFitting(fits, min, max) {
  let low = min;
  let high = Math.max(min, max);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits(mid)) low = mid;
    else high = mid - 1;
  }
  return low;
}

/** The biggest auto font size a sticky of this size uses (a third of its shorter side). */
export function autoFitMax(w, h) {
  return Math.max(AUTO_FIT_MIN, Math.floor(Math.min(w, h) / 3));
}

/**
 * Auto font size: while `enabled`, sets the font size of the element in
 * `ref` to the largest that keeps its text inside it, whenever `deps`
 * change. The element's style must leave fontSize unset meanwhile. Only
 * rendered (not culled) objects measure. Returns `refit`, for an editor to
 * call as its text changes.
 */
export function useAutoFit(ref, enabled, max, deps) {
  const refit = useCallback(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    const fits = (px) => {
      el.style.fontSize = `${px}px`;
      return el.scrollHeight <= el.clientHeight + 1 && el.scrollWidth <= el.clientWidth + 1;
    };
    el.style.fontSize = `${largestFitting(fits, AUTO_FIT_MIN, max)}px`;
  }, [ref, enabled, max]);
  useLayoutEffect(refit, [refit, ...deps]);
  // A board font that finishes loading changes how much text fits.
  useEffect(() => {
    const fonts = typeof document !== "undefined" ? document.fonts : null;
    if (!enabled || !fonts?.addEventListener) return;
    fonts.addEventListener("loadingdone", refit);
    return () => fonts.removeEventListener("loadingdone", refit);
  }, [enabled, refit]);
  return refit;
}
