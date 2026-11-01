"use client";

import { useEffect, useState } from "react";
import { Pause, Play, Square, Volume2, VolumeX } from "lucide-react";
import { cn } from "@/lib/utils";
import { useFacilitationStore } from "@/lib/canvas/facilitation-store";
import { TIMER_MUSIC, TIMER_PRESETS, formatClock, remainingMs } from "@/lib/canvas/facilitation";
import { useCanvasStore } from "@/lib/canvas-store";
import { canEditRole } from "@/lib/board-access";

const BUTTON = "grid h-7 min-w-7 place-items-center rounded-full px-1.5 text-xs font-semibold text-white/85 outline-none transition hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-brand";

function useNow(active) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const interval = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(interval);
  }, [active]);
  return now;
}

/**
 * The countdown, small enough to sit over the board and over a presentation: the clock for everyone, and for
 * people who can edit the board pause, stop and add time. Rings at zero until dismissed with Stop.
 */
export function TimerPill() {
  const timer = useFacilitationStore((s) => s.timer);
  const offset = useFacilitationStore((s) => s.offset);
  const muted = useFacilitationStore((s) => s.muted);
  const role = useCanvasStore((s) => s.boardRole);
  const visible = timer && (timer.state === "running" || timer.state === "paused");
  const now = useNow(visible);
  if (!visible) return null;
  const left = remainingMs(timer, offset, now) ?? 0;
  const editable = canEditRole(role);
  const store = useFacilitationStore.getState();
  const act = (data) => void store.timerAction(data).catch(() => {});
  const done = timer.state === "running" && left === 0;
  return (
    <div
      role="timer"
      aria-label="Board timer"
      data-board-timer=""
      className={cn(
        "flex items-center gap-1 rounded-full border bg-ink-750/95 py-1 pl-3 pr-1.5 shadow-pop backdrop-blur-xl",
        done ? "border-brand text-brand" : "border-line text-white"
      )}
    >
      <span data-timer-clock className="min-w-[3.25rem] text-center font-mono text-sm font-semibold tabular-nums">
        {formatClock(left)}
      </span>
      {timer.state === "paused" && <span className="text-[11px] uppercase tracking-wide text-white/50">Paused</span>}
      {editable && (
        <>
          {timer.state === "running" && !done && (
            <button type="button" aria-label="Pause timer" className={BUTTON} onClick={() => act({ action: "pause" })}>
              <Pause className="h-3.5 w-3.5" />
            </button>
          )}
          {timer.state === "paused" && (
            <button type="button" aria-label="Resume timer" className={BUTTON} onClick={() => act({ action: "resume" })}>
              <Play className="h-3.5 w-3.5" />
            </button>
          )}
          {!done && (
            <>
              <button type="button" aria-label="Add one minute" className={BUTTON} onClick={() => act({ action: "add", addMs: 60000 })}>+1m</button>
              <button type="button" aria-label="Add five minutes" className={BUTTON} onClick={() => act({ action: "add", addMs: 300000 })}>+5m</button>
            </>
          )}
          <button type="button" aria-label="Stop timer" className={BUTTON} onClick={() => act({ action: "stop" })}>
            <Square className="h-3.5 w-3.5" />
          </button>
        </>
      )}
      <button
        type="button"
        aria-label={muted ? "Unmute timer sounds" : "Mute timer sounds"}
        aria-pressed={muted}
        className={BUTTON}
        onClick={() => store.setMuted(!muted)}
      >
        {muted ? <VolumeX className="h-3.5 w-3.5" /> : <Volume2 className="h-3.5 w-3.5" />}
      </button>
    </div>
  );
}

/** Choose a length and optional music, then start the timer. */
export function TimerSetup({ onStarted }) {
  const [minutes, setMinutes] = useState(5);
  const [music, setMusic] = useState("");
  const [error, setError] = useState("");
  const start = async () => {
    setError("");
    try {
      await useFacilitationStore.getState().timerAction({ action: "start", durationMs: Math.round(minutes * 60000), music: music || null });
      onStarted?.();
    } catch (failure) {
      setError(failure.message);
    }
  };
  return (
    <div className="flex flex-col gap-3 p-3" data-timer-setup="">
      <div className="flex flex-wrap gap-1.5">
        {TIMER_PRESETS.map((preset) => (
          <button
            key={preset.ms}
            type="button"
            aria-pressed={minutes * 60000 === preset.ms}
            onClick={() => setMinutes(preset.ms / 60000)}
            className={cn("rounded-full border px-2.5 py-1 text-xs outline-none focus-visible:ring-2 focus-visible:ring-brand",
              minutes * 60000 === preset.ms ? "border-brand bg-brand/15 text-brand" : "border-line text-white/75 hover:text-white")}
          >
            {preset.label}
          </button>
        ))}
      </div>
      <label className="flex items-center justify-between gap-3 text-xs text-white/70">
        Minutes
        <input
          type="number"
          min={0.5}
          max={480}
          step={0.5}
          value={minutes}
          onChange={(e) => setMinutes(Math.min(480, Math.max(0.5, Number(e.target.value) || 0.5)))}
          className="w-20 rounded-md border border-line bg-ink-800 px-2 py-1 text-right text-white outline-none focus:border-brand"
        />
      </label>
      <label className="flex items-center justify-between gap-3 text-xs text-white/70">
        Music
        <select value={music} onChange={(e) => setMusic(e.target.value)} className="rounded-md border border-line bg-ink-800 px-2 py-1 text-white outline-none focus:border-brand">
          <option value="">None</option>
          {TIMER_MUSIC.map((track) => <option key={track.id} value={track.id}>{track.label}</option>)}
        </select>
      </label>
      {error && <p role="alert" className="text-xs text-red-300">{error}</p>}
      <button type="button" onClick={start} className="rounded-lg bg-brand px-3 py-1.5 text-sm font-semibold text-ink-900 outline-none hover:bg-brand/90 focus-visible:ring-2 focus-visible:ring-white">
        Start timer
      </button>
    </div>
  );
}
