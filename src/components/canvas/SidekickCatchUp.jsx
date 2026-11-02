"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Loader2, Sparkles } from "lucide-react";
import { formatCost } from "@/lib/format-cost";
import { useCanvasStore } from "@/lib/canvas-store";
import { fetchCatchUp, quoteCatchUp, submitCatchUp, waitForJob } from "@/lib/sidekick-api";
import { useSidekick } from "@/lib/sidekick";

export const PERIODS = [
  { id: "last", label: "Since my last visit" },
  { id: "1w", label: "Last week" },
  { id: "2w", label: "Last 2 weeks" },
  { id: "1m", label: "Last month" },
];

function when(ms) {
  return new Date(ms).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** Catch up: how much changed while you were away, and an AI summary with highlights you can step through. */
export function CatchUpTab({ boardId }) {
  const [period, setPeriod] = useState("last");
  const [info, setInfo] = useState(null);
  const [quote, setQuote] = useState(null);
  const [summary, setSummary] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [at, setAt] = useState(-1);
  const key = useRef(null);
  const credits = useSidekick((s) => s.credits);

  useEffect(() => {
    let live = true;
    key.current = null;
    setInfo(null);
    setQuote(null);
    setSummary(null);
    setAt(-1);
    fetchCatchUp(boardId, period).then((value) => live && setInfo(value)).catch((e) => live && setError(e.message));
    return () => { live = false; };
  }, [boardId, period]);

  useEffect(() => {
    if (!info || info.changes === 0) return undefined;
    let live = true;
    quoteCatchUp(boardId, { period }).then((value) => live && setQuote(value)).catch((e) => live && setError(e.message));
    return () => { live = false; };
  }, [boardId, period, info]);

  const run = async () => {
    setBusy(true);
    setError(null);
    key.current ??= crypto.randomUUID();
    try {
      const job = await submitCatchUp(boardId, { period }, key.current);
      key.current = null;
      const done = await waitForJob(boardId, job.id);
      if (done.status !== "succeeded") throw new Error(done.error || "The summary did not finish.");
      setSummary(done.result);
      void useSidekick.getState().loadCredits();
    } catch (e) {
      if (e.status < 500) key.current = null;
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const present = useCanvasStore((s) => s.history.present);
  const onBoard = (id) => id && present.nodes.some((node) => node.id === id);
  const highlights = summary?.highlights ?? [];
  const jumpable = highlights.map((item, index) => ({ item, index })).filter(({ item }) => onBoard(item.nodeId));
  const step = (direction) => {
    if (!jumpable.length) return;
    const current = jumpable.findIndex(({ index }) => index === at);
    const next = jumpable[(current + direction + jumpable.length) % jumpable.length];
    setAt(next.index);
    useCanvasStore.getState().focusObject(next.item.nodeId);
  };
  const exhausted = credits && credits.remainingCents <= 0;

  return (
    <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto px-3 py-2.5 text-xs text-white/70">
      <label className="flex items-center gap-2 text-white/60">Show changes
        <select value={period} onChange={(e) => setPeriod(e.target.value)} aria-label="Period" className="rounded-md border border-line bg-ink-900/60 px-1.5 py-1 text-white/80">
          {PERIODS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
        </select>
      </label>
      {info && <p data-testid="catchup-info">{info.changes === 0 ? `Nothing has changed since ${when(info.since)}.` : `${info.changes} change${info.changes === 1 ? "" : "s"} since ${when(info.since)}.`}</p>}
      {error && <p role="alert" className="rounded-md bg-red-500/10 px-2.5 py-1.5 text-red-300">{error}</p>}
      {info?.changes > 0 && !summary && (
        <button type="button" onClick={() => void run()} disabled={busy || !quote || exhausted} className="flex items-center gap-1.5 rounded-md bg-brand px-3 py-1.5 font-medium text-white disabled:opacity-40">
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Sparkles className="h-3.5 w-3.5" aria-hidden />}
          Summarize{quote ? ` (~${formatCost(quote.costCents)})` : ""}
        </button>
      )}
      {summary && (
        <div className="space-y-2">
          <p className="whitespace-pre-wrap text-sm text-white/85">{summary.summary}</p>
          {highlights.length > 0 && (
            <>
              <div className="flex items-center gap-1 text-white/60">
                <span className="font-medium text-white/80">Highlights</span>
                {jumpable.length > 0 && (
                  <span className="ml-auto flex items-center gap-1">
                    <button type="button" aria-label="Previous highlight" onClick={() => step(-1)} className="rounded-md p-1 hover:bg-white/[0.07]"><ChevronLeft className="h-3.5 w-3.5" /></button>
                    <button type="button" aria-label="Next highlight" onClick={() => step(1)} className="rounded-md p-1 hover:bg-white/[0.07]"><ChevronRight className="h-3.5 w-3.5" /></button>
                  </span>
                )}
              </div>
              <ul className="space-y-1">
                {highlights.map((item, index) => (
                  <li key={index}>
                    <button type="button" disabled={!onBoard(item.nodeId)} onClick={() => { setAt(index); useCanvasStore.getState().focusObject(item.nodeId); }} className={`w-full rounded-md px-2 py-1 text-left hover:bg-white/[0.07] disabled:cursor-default disabled:hover:bg-transparent ${at === index ? "bg-white/[0.07] text-white" : ""}`}>{item.text}</button>
                  </li>
                ))}
              </ul>
            </>
          )}
          {summary.actionItems?.length > 0 && (
            <>
              <p className="font-medium text-white/80">Action items</p>
              <ul className="list-disc space-y-0.5 pl-5">{summary.actionItems.map((item, index) => <li key={index}>{item}</li>)}</ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}
