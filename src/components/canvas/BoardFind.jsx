"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronUp, ChevronRight, Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useCanvasStore } from "@/lib/canvas-store";
import { useBoardUi } from "@/lib/canvas/board-ui";
import { FIND_TYPES, findOnBoard, matchCount, replaceMatches, replaceOneMatch } from "@/lib/canvas/find";
import { nodeBounds, worldToScreen } from "@/lib/canvas/geometry";

const ICON_BUTTON =
  "grid h-7 w-7 shrink-0 place-items-center rounded-lg text-white/60 outline-none hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-brand disabled:pointer-events-none disabled:opacity-35";
const CHIP =
  "rounded-full border px-2.5 py-1 text-xs outline-none transition focus-visible:ring-2 focus-visible:ring-brand";
const TEXT_BUTTON =
  "rounded-lg px-2.5 py-1.5 text-xs font-semibold outline-none transition focus-visible:ring-2 focus-visible:ring-brand disabled:pointer-events-none disabled:opacity-40";

/**
 * Find (and, for editors, replace) on the board. Searches the board data,
 * so objects scrolled out of view are found too. Each jump selects the hit
 * and brings it into view; the overlay dims everything else.
 */
export function BoardFind({ canEdit, onClose }) {
  const present = useCanvasStore((s) => s.history.present);
  const [query, setQuery] = useState("");
  const [types, setTypes] = useState([]);
  const [matchCase, setMatchCase] = useState(false);
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [replacement, setReplacement] = useState("");
  const [current, setCurrent] = useState(0);
  const [currentRange, setCurrentRange] = useState(0);
  const inputRef = useRef(null);
  const replaceRef = useRef(null);

  const hits = useMemo(() => findOnBoard(present, query, { types, matchCase }), [present, query, types, matchCase]);
  const index = hits.length ? Math.min(current, hits.length - 1) : -1;
  const currentId = index >= 0 ? hits[index].id : null;
  const rangeIndex = index >= 0 ? Math.min(currentRange, hits[index].ranges.length - 1) : 0;

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    useBoardUi.getState().setFindHits({ ids: hits.map((hit) => hit.id), current: currentId });
  }, [hits, currentId]);

  // A new search starts again from the first hit.
  useEffect(() => {
    setCurrent(0);
    setCurrentRange(0);
  }, [query, types, matchCase]);

  const jump = (next) => {
    if (!hits.length) return;
    const at = (next + hits.length) % hits.length;
    setCurrent(at);
    setCurrentRange(0);
    useCanvasStore.getState().focusObject(hits[at].id);
  };

  // Typing shows the first hit without moving focus out of the field.
  useEffect(() => {
    if (hits.length && query) useCanvasStore.getState().focusObject(hits[0].id);
    // Only a changed search jumps; edits to the board while searching do not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, types, matchCase]);

  const replaceOne = () => {
    if (index < 0) return;
    const store = useCanvasStore.getState();
    const done = replaceOneMatch(store.history.present, hits, { hit: index, range: rangeIndex }, replacement, query, { types, matchCase });
    store.replaceNodes(done.edits);
    setCurrent(done.at?.hit ?? 0);
    setCurrentRange(done.at?.range ?? 0);
    if (done.at && done.hits[done.at.hit].id !== currentId) store.focusObject(done.hits[done.at.hit].id);
    // The button disables once no match is left; keep focus (and Escape) in find.
    replaceRef.current?.focus();
  };
  const replaceAll = () => {
    const store = useCanvasStore.getState();
    const edits = replaceMatches(store.history.present, hits, replacement);
    store.replaceNodes(edits);
    useBoardUi.getState().notify(`Replaced ${matchCount(hits)} ${matchCount(hits) === 1 ? "match" : "matches"}`);
    replaceRef.current?.focus();
  };

  const onKeyDown = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
      e.preventDefault();
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  };

  const toggleType = (id) => setTypes((all) => (all.includes(id) ? all.filter((t) => t !== id) : [...all, id]));
  const total = matchCount(hits);

  return (
    <section
      role="search"
      aria-label="Find on board"
      data-board-keys="own"
      onKeyDown={onKeyDown}
      className="absolute left-1/2 top-16 z-40 w-[26rem] max-w-[calc(100%-2rem)] -translate-x-1/2 rounded-2xl border border-line bg-ink-750/95 p-2 shadow-pop backdrop-blur-xl"
    >
      <div className="flex items-center gap-1">
        {canEdit && (
          <button
            type="button"
            aria-label={replaceOpen ? "Hide replace" : "Show replace"}
            aria-expanded={replaceOpen}
            onClick={() => setReplaceOpen((open) => !open)}
            className={ICON_BUTTON}
          >
            <ChevronRight className={cn("h-4 w-4 transition-transform", replaceOpen && "rotate-90")} />
          </button>
        )}
        <label className="flex min-w-0 flex-1 items-center gap-2 rounded-lg bg-ink-800 px-2.5 py-1.5 ring-1 ring-line focus-within:ring-brand/70">
          <Search className="h-3.5 w-3.5 shrink-0 text-white/40" aria-hidden />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                jump(e.shiftKey ? index - 1 : index + 1);
              }
            }}
            placeholder="Find on board"
            aria-label="Find on board"
            className="min-w-0 flex-1 bg-transparent text-sm text-white placeholder:text-white/35 outline-none"
          />
        </label>
        <button
          type="button"
          aria-label="Match case"
          title="Match case"
          aria-pressed={matchCase}
          onClick={() => setMatchCase((v) => !v)}
          className={cn(ICON_BUTTON, "text-xs font-semibold", matchCase && "bg-brand/15 text-white ring-1 ring-brand/60")}
        >
          Aa
        </button>
        <span className="w-16 shrink-0 text-center text-xs tabular-nums text-white/55" aria-live="polite" data-testid="find-count">
          {query ? (hits.length ? `${index + 1} of ${hits.length}` : "No results") : ""}
        </span>
        <button type="button" aria-label="Previous result" disabled={!hits.length} onClick={() => jump(index - 1)} className={ICON_BUTTON}>
          <ChevronUp className="h-4 w-4" />
        </button>
        <button type="button" aria-label="Next result" disabled={!hits.length} onClick={() => jump(index + 1)} className={ICON_BUTTON}>
          <ChevronDown className="h-4 w-4" />
        </button>
        <button type="button" aria-label="Close find" onClick={onClose} className={ICON_BUTTON}>
          <X className="h-4 w-4" />
        </button>
      </div>

      {replaceOpen && canEdit && (
        <div className="mt-1.5 flex items-center gap-1.5 pl-8">
          <input
            value={replacement}
            onChange={(e) => setReplacement(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (e.metaKey || e.ctrlKey) replaceAll();
                else replaceOne();
              }
            }}
            ref={replaceRef}
            placeholder="Replace with"
            aria-label="Replace with"
            className="min-w-0 flex-1 rounded-lg bg-ink-800 px-2.5 py-1.5 text-sm text-white placeholder:text-white/35 outline-none ring-1 ring-line focus:ring-brand/70"
          />
          <button type="button" disabled={!hits.length} onClick={replaceOne} className={cn(TEXT_BUTTON, "text-white/80 hover:bg-white/10 hover:text-white")}>
            Replace
          </button>
          <button type="button" disabled={!hits.length} onClick={replaceAll} className={cn(TEXT_BUTTON, "bg-brand/20 text-brand hover:bg-brand/30")}>
            Replace all{total ? ` (${total})` : ""}
          </button>
        </div>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-1.5 pl-1" role="group" aria-label="Filter by type">
        {FIND_TYPES.map((type) => {
          const on = types.includes(type.id);
          return (
            <button
              key={type.id}
              type="button"
              aria-pressed={on}
              onClick={() => toggleType(type.id)}
              className={cn(CHIP, on ? "border-brand/60 bg-brand/15 text-white" : "border-line text-white/60 hover:text-white")}
            >
              {type.label}
            </button>
          );
        })}
      </div>
    </section>
  );
}

/**
 * Dims the board around the finder's hits and rings each one, the current
 * hit brightest. Drawn from the board data and the view, so it follows pans
 * and zooms and includes hits the canvas has culled.
 */
export function BoardFindOverlay() {
  const findHits = useBoardUi((s) => s.findHits);
  const nodes = useCanvasStore((s) => s.history.present.nodes);
  const viewport = useCanvasStore((s) => s.history.present.viewport);

  const boxes = useMemo(() => {
    if (!findHits.ids.length) return [];
    const wanted = new Set(findHits.ids);
    return nodes
      .filter((n) => wanted.has(n.id))
      .map((n) => {
        const b = nodeBounds(n);
        const p = worldToScreen(b, viewport);
        return { id: n.id, x: p.x - 4, y: p.y - 4, w: b.w * viewport.zoom + 8, h: b.h * viewport.zoom + 8 };
      });
  }, [findHits.ids, nodes, viewport]);

  if (!boxes.length) return null;
  return (
    <svg className="pointer-events-none absolute inset-0 z-[5] h-full w-full" aria-hidden data-testid="find-overlay">
      <defs>
        <mask id="board-find-mask">
          <rect width="100%" height="100%" fill="white" />
          {boxes.map((b) => (
            <rect key={b.id} x={b.x} y={b.y} width={b.w} height={b.h} rx={8} fill="black" />
          ))}
        </mask>
      </defs>
      <rect width="100%" height="100%" fill="rgba(7,7,8,0.55)" mask="url(#board-find-mask)" />
      {boxes.map((b) => (
        <rect
          key={b.id}
          x={b.x}
          y={b.y}
          width={b.w}
          height={b.h}
          rx={8}
          fill="none"
          stroke={b.id === findHits.current ? "#facc15" : "rgba(255,255,255,0.55)"}
          strokeWidth={b.id === findHits.current ? 3 : 1.5}
        />
      ))}
    </svg>
  );
}
