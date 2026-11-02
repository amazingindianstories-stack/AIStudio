"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronLeft, EyeOff, Timer, Trophy, Vote, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useFacilitationStore } from "@/lib/canvas/facilitation-store";
import { useFacilitation } from "@/lib/canvas/use-facilitation";
import { useCanvasStore } from "@/lib/canvas-store";
import { canEditRole } from "@/lib/board-access";
import { TimerPill, TimerSetup } from "./TimerControls";
import { VotingBar, VotingHistory, VotingSetup } from "./VotingControls";
import { PrivateModeBar, PrivateModeSetup } from "./PrivateModeControls";

const ITEM = "flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm text-white/85 outline-none transition hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-40";
const TITLES = { timer: "Timer", voting: "Start voting", history: "Voting results", private: "Private mode" };

/** The header button that opens the facilitation menu: timer, voting and private mode. */
export function FacilitationButton({ boardId }) {
  useFacilitation(boardId);
  const [view, setView] = useState(null);
  const [open, setOpen] = useState(false);
  const role = useCanvasStore((s) => s.boardRole);
  const active = useFacilitationStore((s) => s.voting.active);
  const privateOn = useFacilitationStore((s) => s.privateMode?.active);
  const timerOn = useFacilitationStore((s) => s.timer?.state === "running" || s.timer?.state === "paused");
  const editable = canEditRole(role);
  const rootRef = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (event) => {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    };
    const onKey = (event) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const close = () => {
    setOpen(false);
    setView(null);
  };
  const live = Boolean(active || privateOn || timerOn);
  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="menu"
        data-facilitate-button=""
        onClick={() => { setOpen((value) => !value); setView(null); }}
        className={cn(
          "flex items-center gap-1.5 rounded-full border border-line bg-ink-700 px-3 py-1.5 text-sm text-white/85 outline-none transition hover:text-white focus-visible:ring-2 focus-visible:ring-brand",
          (open || live) && "bg-ink-600 text-white"
        )}
      >
        <Vote className="h-3.5 w-3.5" />
        Facilitate
        {live && <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-brand" />}
      </button>
      {open && (
        <div role="menu" className="absolute left-0 top-full z-50 mt-2 w-72 max-w-[calc(100vw-2rem)] rounded-2xl border border-line bg-ink-750/95 shadow-pop backdrop-blur-xl">
          {view ? (
            <>
              <div className="flex items-center gap-1 border-b border-line px-2 py-1.5">
                <button type="button" aria-label="Back" onClick={() => setView(null)} className="grid h-6 w-6 place-items-center rounded-full text-white/70 hover:bg-white/10 hover:text-white"><ChevronLeft className="h-4 w-4" /></button>
                <span className="flex-1 text-sm font-semibold text-white">{TITLES[view]}</span>
                <button type="button" aria-label="Close" onClick={close} className="grid h-6 w-6 place-items-center rounded-full text-white/70 hover:bg-white/10 hover:text-white"><X className="h-4 w-4" /></button>
              </div>
              {view === "timer" && <TimerSetup onStarted={close} />}
              {view === "voting" && <VotingSetup onClose={close} />}
              {view === "history" && <VotingHistory />}
              {view === "private" && <PrivateModeSetup onStarted={close} />}
            </>
          ) : (
            <div className="flex flex-col p-1.5">
              {editable && <button type="button" role="menuitem" onClick={() => setView("timer")} className={ITEM}><Timer className="h-4 w-4" />Timer</button>}
              {editable && <button type="button" role="menuitem" disabled={Boolean(active)} onClick={() => setView("voting")} className={ITEM}><Vote className="h-4 w-4" />{active ? "Voting is running" : "Start voting"}</button>}
              <button type="button" role="menuitem" onClick={() => setView("history")} className={ITEM}><Trophy className="h-4 w-4" />Voting results</button>
              {editable && <button type="button" role="menuitem" disabled={Boolean(privateOn)} onClick={() => setView("private")} className={ITEM}><EyeOff className="h-4 w-4" />{privateOn ? "Private mode is on" : "Private mode"}</button>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** What is live on the board, always visible at the top: the timer, the voting session, private mode. */
export function FacilitationDock() {
  return (
    <div data-facilitation-dock="" className="pointer-events-none absolute left-1/2 top-16 z-40 flex -translate-x-1/2 flex-col items-center gap-2 max-w-[calc(100%-2rem)]">
      <div className="pointer-events-auto"><TimerPill /></div>
      <div className="pointer-events-auto"><VotingBar /></div>
      <div className="pointer-events-auto"><PrivateModeBar /></div>
    </div>
  );
}
