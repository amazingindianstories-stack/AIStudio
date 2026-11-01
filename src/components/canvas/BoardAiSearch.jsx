"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { formatCost } from "@/lib/format-cost";
import { fetchSearch, quoteSearch, submitSearch, waitForJob } from "@/lib/sidekick-api";

const QUOTE_DELAY_MS = 400;

/**
 * Ask in plain words for boards ("boards about the chase scene I changed last week"). The question becomes filters
 * (name words, how recent, only mine) in one small paid job; the filters then run over this project's boards that you
 * can open. The price is shown first and the search starts only when you press Find.
 */
export function BoardAiSearch({ boardId, onPick }) {
  const [query, setQuery] = useState("");
  const [quote, setQuote] = useState(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const key = useRef({ query: null, id: null });

  useEffect(() => {
    setQuote(null);
    if (!query.trim() || !boardId) return undefined;
    let live = true;
    const timer = setTimeout(() => {
      quoteSearch(boardId, { query }).then((value) => live && setQuote(value)).catch((e) => live && setError(e.message));
    }, QUOTE_DELAY_MS);
    return () => { live = false; clearTimeout(timer); };
  }, [query, boardId]);

  const find = async () => {
    if (!quote || busy) return;
    setBusy(true);
    setError(null);
    if (key.current.query !== query) key.current = { query, id: crypto.randomUUID() };
    try {
      const job = await submitSearch(boardId, { query }, key.current.id);
      const done = await waitForJob(boardId, job.id);
      if (done.status !== "succeeded") throw new Error(done.error || "The search did not finish.");
      setResult(await fetchSearch(boardId, job.id));
      key.current = { query: null, id: null };
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mb-1.5 border-b border-line pb-1.5" onKeyDown={(event) => event.stopPropagation()}>
      <div className="flex items-center gap-1">
        <input
          value={query}
          onChange={(e) => { setQuery(e.target.value); setResult(null); }}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void find(); } }}
          maxLength={300}
          aria-label="Ask AI to find a board"
          placeholder="Ask AI to find a board"
          className="min-w-0 flex-1 rounded-lg border border-line bg-ink-900/60 px-2.5 py-1.5 text-xs text-white/90 placeholder:text-white/35"
        />
        <button type="button" onClick={() => void find()} disabled={!quote || busy} title={quote ? `About ${formatCost(quote.costCents)}` : "Type a question first"} className="flex shrink-0 items-center gap-1 rounded-md bg-ink-600 px-2 py-1.5 text-xs font-medium text-white ring-1 ring-line disabled:opacity-40">
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Sparkles className="h-3.5 w-3.5" aria-hidden />}Find
        </button>
      </div>
      {quote && !result && <p className="px-1 pt-1 text-[11px] text-white/45">About {formatCost(quote.costCents)}</p>}
      {error && <p role="alert" className="px-1 pt-1 text-[11px] text-red-300">{error}</p>}
      {result && (
        <div className="pt-1">
          {result.filters?.explanation && <p className="px-1 pb-1 text-[11px] text-white/45">{result.filters.explanation}</p>}
          {result.boards.length === 0 ? <p className="px-1 text-xs text-white/55">No boards match.</p> : (
            <ul aria-label="AI search results">
              {result.boards.map((item) => (
                <li key={item.id}><button type="button" onClick={() => onPick(item.id)} className="w-full truncate rounded-md px-2 py-1.5 text-left text-sm text-white/85 hover:bg-white/[0.07]">{item.name}</button></li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
