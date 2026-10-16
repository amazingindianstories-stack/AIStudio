"use client";

import { useSyncExternalStore } from "react";

const QUERY = "(min-width: 1024px)";

function subscribe(onChange) {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const media = window.matchMedia(QUERY);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

const getSnapshot = () => (typeof window !== "undefined" && window.matchMedia ? window.matchMedia(QUERY).matches : true);
// Server render assumes desktop; the client corrects after hydration without a mismatch.
const getServerSnapshot = () => true;

/** True on the desktop layout (the right assets panel); false when the mobile drawer is used. */
export function useDesktopLayout() {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
