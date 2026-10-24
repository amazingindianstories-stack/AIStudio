"use client";
import { useEffect } from "react";
import { useStore } from "./store";
import { localDateKey } from "./library-filters";

/** Refresh relative predicates and date labels after midnight or a timezone change. */
export function useLibraryDayClock() {
  useEffect(() => {
    let timer;
    let timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const refresh = () => {
      clearTimeout(timer);
      const now = Date.now(), nextZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (localDateKey(now) !== localDateKey(useStore.getState().libraryDateNow) || nextZone !== timezone) useStore.getState().setLibraryDateNow(now);
      timezone = nextZone;
      const midnight = new Date(now);
      midnight.setHours(24, 0, 0, 0);
      timer = setTimeout(refresh, Math.max(1000, midnight.getTime() - now + 100));
    };
    refresh();
    document.addEventListener("visibilitychange", refresh);
    return () => { clearTimeout(timer); document.removeEventListener("visibilitychange", refresh); };
  }, []);
}
