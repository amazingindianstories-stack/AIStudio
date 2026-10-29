"use client";

import { useMediaQuery } from "./use-media-query";

/** True on the desktop layout (the right assets panel); false when the mobile drawer is used. */
export function useDesktopLayout() {
  // Server render assumes desktop; the client corrects after hydration without a mismatch.
  return useMediaQuery("(min-width: 1024px)", true);
}
