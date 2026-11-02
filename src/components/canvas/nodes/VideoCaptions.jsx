"use client";

import { useCallback, useEffect, useState } from "react";
import { Captions } from "lucide-react";
import { useCanvasStore, selectReadOnly } from "@/lib/canvas-store";
import { costLabel, generateCaptions, loadCaptionTrack, quoteCaptions } from "@/lib/canvas/captions-api";

/**
 * Captions for a board video: state for the quote, the generate step and the CC toggle. The track is a blob URL of
 * the VTT fetched through the API, so the video itself stays free of crossOrigin. Only editors can generate.
 */
const QUOTE_TRIES = 5;
const QUOTE_RETRY_MS = 2000;

export function useVideoCaptions(node, active) {
  const boardId = useCanvasStore((s) => s.boardId);
  const canGenerate = useCanvasStore((s) => !selectReadOnly(s));
  const [quote, setQuote] = useState(null);
  const [on, setOn] = useState(false);
  const [trackUrl, setTrackUrl] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [tries, setTries] = useState(0);
  const exists = Boolean(quote?.exists);

  // A video just added to the board is not saved yet, so the first quote can answer 404: ask again shortly.
  useEffect(() => {
    if (!active || !boardId || quote || tries >= QUOTE_TRIES) return undefined;
    let cancelled = false;
    let timer = null;
    quoteCaptions(boardId, node.src).then((q) => { if (!cancelled) setQuote(q); }, () => {
      if (!cancelled) timer = setTimeout(() => setTries((n) => n + 1), QUOTE_RETRY_MS);
    });
    return () => { cancelled = true; clearTimeout(timer); };
  }, [active, boardId, node.src, quote, tries]);

  useEffect(() => {
    if (!on || !exists || !boardId) return undefined;
    let cancelled = false;
    let url = null;
    loadCaptionTrack(boardId, node.src).then((made) => {
      if (cancelled) URL.revokeObjectURL(made); else { url = made; setTrackUrl(made); }
    }, (e) => { if (!cancelled) { setOn(false); setError(e.message); } });
    return () => { cancelled = true; if (url) URL.revokeObjectURL(url); setTrackUrl(null); };
  }, [on, exists, boardId, node.src]);

  const generate = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const result = await generateCaptions(boardId, node.src);
      setQuote((q) => ({ ...q, ...result }));
      setConfirming(false);
      setOn(true);
    } catch (e) {
      setError(e.message || "Captions could not be generated.");
    } finally {
      setBusy(false);
    }
  }, [boardId, node.src]);

  return { quote, exists, on, setOn, trackUrl, confirming, setConfirming, busy, error, canGenerate, generate };
}

const stop = (e) => e.stopPropagation();

export function CaptionControls({ captions }) {
  const { quote, exists, on, setOn, confirming, setConfirming, busy, error, canGenerate, generate } = captions;
  if (!quote) return null;
  const available = quote.available !== false;
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 bg-black/70 px-2 py-1 text-[11px] text-white/80" data-captions-controls="" onPointerDown={stop}>
      {exists ? (
        <button type="button" aria-pressed={on} onClick={() => setOn(!on)} data-captions-toggle=""
          className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 ${on ? "bg-white text-black" : "bg-white/15"}`}>
          <Captions className="h-3 w-3" aria-hidden />
          CC
        </button>
      ) : canGenerate && available && !confirming ? (
        <button type="button" onClick={() => setConfirming(true)} data-captions-generate=""
          className="inline-flex items-center gap-1 rounded bg-white/15 px-1.5 py-0.5">
          <Captions className="h-3 w-3" aria-hidden />
          Generate captions
        </button>
      ) : null}
      {confirming && !exists && (
        <span className="flex flex-wrap items-center gap-2" data-captions-confirm="">
          <span>{costLabel(quote)}</span>
          <button type="button" disabled={busy} onClick={generate} data-captions-start="" className="rounded bg-white px-1.5 py-0.5 text-black disabled:opacity-60">
            {busy ? "Generating..." : "Start"}
          </button>
          <button type="button" disabled={busy} onClick={() => setConfirming(false)} className="rounded bg-white/15 px-1.5 py-0.5">Cancel</button>
        </span>
      )}
      {error && <span role="alert" className="text-red-300" data-captions-error="">{error}</span>}
    </div>
  );
}
