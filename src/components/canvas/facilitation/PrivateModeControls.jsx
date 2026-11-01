"use client";

import { useEffect, useState } from "react";
import { EyeOff } from "lucide-react";
import { cn } from "@/lib/utils";
import { useFacilitationStore } from "@/lib/canvas/facilitation-store";
import { revealCountdown } from "@/lib/canvas/facilitation";
import { useCanvasStore } from "@/lib/canvas-store";
import { canEditRole } from "@/lib/board-access";
import { currentUserId } from "@/lib/canvas/sticky-actions";

const PILL = "rounded-full border border-line px-3 py-1 text-xs font-medium text-white/85 outline-none transition hover:text-white focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-40";

/** Start private mode: new and edited sticky notes stay hidden from everyone else until revealed. */
export function PrivateModeSetup({ onStarted }) {
  const [anonymous, setAnonymous] = useState(false);
  const [allowOthersEnd, setAllowOthersEnd] = useState(true);
  const [error, setError] = useState("");
  const start = async () => {
    setError("");
    try {
      await useFacilitationStore.getState().privateAction({ action: "start", anonymous, allowOthersEnd });
      onStarted?.();
    } catch (failure) {
      setError(failure.message);
    }
  };
  return (
    <div data-private-setup="" className="flex flex-col gap-3 p-3 text-xs text-white/75">
      <p>Sticky notes people add or edit stay hidden from everyone else until you reveal them.</p>
      <label className="flex items-center gap-2"><input type="checkbox" checked={anonymous} onChange={(e) => setAnonymous(e.target.checked)} /> Anonymous: never show who wrote a note</label>
      <label className="flex items-center gap-2"><input type="checkbox" checked={allowOthersEnd} onChange={(e) => setAllowOthersEnd(e.target.checked)} /> Let others reveal everything and end it</label>
      {error && <p role="alert" className="text-red-300">{error}</p>}
      <button type="button" onClick={start} className="rounded-lg bg-brand px-3 py-1.5 text-sm font-semibold text-ink-900 outline-none hover:bg-brand/90 focus-visible:ring-2 focus-visible:ring-white">
        Start private mode
      </button>
    </div>
  );
}

/** What private mode shows while it is on: the state, reveal controls and the five-second countdown. */
export function PrivateModeBar() {
  const mode = useFacilitationStore((s) => s.privateMode);
  const offset = useFacilitationStore((s) => s.offset);
  const role = useCanvasStore((s) => s.boardRole);
  const [now, setNow] = useState(() => Date.now());
  const active = Boolean(mode?.active);
  useEffect(() => {
    if (!active) return undefined;
    const interval = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(interval);
  }, [active]);
  if (!active) return null;
  const countdown = revealCountdown(mode, offset, now);
  const store = useFacilitationStore.getState();
  const me = currentUserId();
  const mayEnd = canEditRole(role) && (mode.allowOthersEnd || mode.startedBy === me);
  const act = (action) => void store.privateAction({ action }).catch(() => {});
  return (
    <div data-private-bar="" role="status" className={cn("flex items-center gap-3 rounded-full border bg-ink-750/95 px-3 py-1.5 text-xs shadow-pop backdrop-blur-xl", countdown ? "border-brand text-brand" : "border-line text-white/80")}>
      <EyeOff className="h-3.5 w-3.5" />
      {countdown ? (
        <span data-reveal-countdown className="font-semibold tabular-nums">Revealing in {countdown}</span>
      ) : (
        <>
          <span>Private mode{mode.anonymous ? ", anonymous" : ""}: notes are hidden</span>
          {canEditRole(role) && <button type="button" onClick={() => act("revealMine")} className={PILL}>Reveal my notes</button>}
          {mayEnd && mode.revealAt == null && <button type="button" onClick={() => act("reveal")} className={cn(PILL, "border-brand text-brand")}>Reveal all</button>}
        </>
      )}
    </div>
  );
}
