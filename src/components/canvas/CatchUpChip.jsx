"use client";

import { useEffect, useState } from "react";
import { Sparkles, X } from "lucide-react";
import { fetchCatchUp, recordVisit } from "@/lib/sidekick-api";

/**
 * Shown when a board opens with changes made while you were away. The visit is recorded when the board is left (not
 * when it opens), so "since my last visit" stays the time you last saw it.
 */
export function CatchUpChip({ boardId, onOpen }) {
  const [changes, setChanges] = useState(0);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!boardId) return undefined;
    let live = true;
    setChanges(0);
    setDismissed(false);
    fetchCatchUp(boardId, "last").then((info) => live && setChanges(info.changes)).catch(() => {});
    const leave = () => void recordVisit(boardId);
    window.addEventListener("pagehide", leave);
    return () => {
      live = false;
      window.removeEventListener("pagehide", leave);
      leave();
    };
  }, [boardId]);

  if (!changes || dismissed) return null;
  return (
    <div className="absolute left-1/2 top-3 z-[44] flex -translate-x-1/2 items-center gap-2 rounded-full border border-line bg-ink-750/95 py-1 pl-3 pr-1 text-xs text-white/80 shadow-pop backdrop-blur-xl">
      <Sparkles className="h-3.5 w-3.5 text-brand" aria-hidden />
      <span>{changes} change{changes === 1 ? "" : "s"} since you were last here</span>
      <button type="button" onClick={() => { setDismissed(true); onOpen(); }} className="rounded-full bg-ink-600 px-2.5 py-1 font-medium text-white ring-1 ring-line">Catch up</button>
      <button type="button" aria-label="Dismiss" onClick={() => setDismissed(true)} className="grid h-6 w-6 place-items-center rounded-full text-white/50 hover:bg-white/[0.07] hover:text-white"><X className="h-3.5 w-3.5" /></button>
    </div>
  );
}
