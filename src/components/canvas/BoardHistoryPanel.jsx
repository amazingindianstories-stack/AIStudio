"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Pencil, Plus, Trash2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useCanvasStore } from "@/lib/canvas-store";
import { displayName } from "@/lib/board-access";
import { describeChange, fetchBoardActivity, formatDay, formatTime, groupActivity } from "@/lib/canvas/board-activity";
import { usePeople } from "@/lib/canvas/use-people";

const ACTION_ICONS = { add: Plus, edit: Pencil, delete: Trash2 };

const entryKey = (entry) => `${entry.at}:${entry.action}:${entry.nodeId}`;

/**
 * The board's change history for people who can edit it: who added, edited
 * and deleted which objects over the last 90 days, newest first and grouped
 * by person and day. Choosing an object still on the board selects it and
 * brings it into view.
 */
export function BoardHistoryPanel({ boardId, onClose }) {
  const people = usePeople({ refresh: true });
  const serverVersion = useCanvasStore((s) => s.serverVersion);
  const present = useCanvasStore((s) => s.history.present);
  const [entries, setEntries] = useState([]);
  const [next, setNext] = useState(null);
  const [status, setStatus] = useState("loading");
  const [loadingOlder, setLoadingOlder] = useState(false);
  const panelRef = useRef(null);
  const request = useRef(0);
  const loaded = useRef([]);
  useEffect(() => {
    loaded.current = entries;
  }, [entries]);

  // The first page, again whenever the board changes. Newer entries go on top of the
  // pages already loaded, unless so many arrived that they no longer meet.
  const refresh = useCallback(async () => {
    const id = ++request.current;
    try {
      const page = await fetchBoardActivity(boardId);
      if (id !== request.current) return;
      const current = loaded.current;
      const newest = current[0]?.at;
      const newer = page.activity.filter((entry) => entry.at > newest);
      if (!current.length || (newer.length === page.activity.length && page.next)) {
        setEntries(page.activity);
        setNext(page.next);
      } else if (newer.length) {
        setEntries([...newer, ...current]);
      }
      setStatus("ready");
    } catch {
      if (id === request.current) setStatus((current) => (current === "ready" ? current : "error"));
    }
  }, [boardId]);

  useEffect(() => {
    void refresh();
  }, [refresh, serverVersion]);

  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (event) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const loadOlder = async () => {
    if (!next || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const page = await fetchBoardActivity(boardId, next);
      setEntries((current) => {
        const seen = new Set(current.map(entryKey));
        return [...current, ...page.activity.filter((entry) => !seen.has(entryKey(entry)))];
      });
      setNext(page.next);
    } catch {
      // The button stays, so the person can try again.
    } finally {
      setLoadingOlder(false);
    }
  };

  const onBoard = useMemo(
    () => new Set([...present.nodes.map((node) => node.id), ...present.connectors.map((connector) => connector.id)]),
    [present.nodes, present.connectors]
  );
  const groups = useMemo(() => groupActivity(entries), [entries]);
  const now = Date.now();

  return (
    <section
      ref={panelRef}
      tabIndex={-1}
      aria-label="Board history"
      className="absolute right-4 top-16 z-40 flex max-h-[min(560px,calc(100%-11rem))] w-80 max-w-[calc(100%-2rem)] flex-col overflow-hidden rounded-2xl border border-line bg-ink-750/95 shadow-pop outline-none backdrop-blur-xl"
    >
      <header className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-white/90">History</h2>
          <p className="text-xs text-white/45">Changes from the last 90 days</p>
        </div>
        <button
          type="button"
          aria-label="Close history"
          onClick={onClose}
          className="grid h-7 w-7 place-items-center rounded-lg text-white/50 outline-none hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-brand"
        >
          <X className="h-4 w-4" />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {status === "loading" && (
          <p className="flex items-center gap-2 px-2 py-6 text-xs text-white/50" role="status">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading history…
          </p>
        )}
        {status === "error" && (
          <div className="px-2 py-6 text-xs text-white/60">
            <p>History could not be loaded.</p>
            <button type="button" onClick={() => void refresh()} className="mt-2 font-semibold text-brand outline-none hover:underline focus-visible:ring-2 focus-visible:ring-brand">
              Try again
            </button>
          </div>
        )}
        {status === "ready" && !groups.length && <p className="px-2 py-6 text-xs text-white/50">No changes recorded yet.</p>}
        {status === "ready" && groups.length > 0 && (
          <ol className="space-y-3">
            {groups.map((group) => {
              const person = people.get(group.actorId);
              const name = group.actorId ? displayName(person, group.actorId) : "Someone";
              return (
                <li key={group.key}>
                  <div className="flex items-center gap-2 px-2 pb-1">
                    <span
                      aria-hidden
                      className="grid h-5 w-5 shrink-0 place-items-center rounded-full text-[10px] font-semibold text-ink-900"
                      style={{ background: person?.color || "#34d399" }}
                    >
                      {name.charAt(0).toUpperCase()}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-xs font-semibold text-white/85">{name}</span>
                    <span className="shrink-0 text-[11px] text-white/40">{formatDay(group.at, now)}</span>
                  </div>
                  <ul>
                    {group.entries.map((entry) => (
                      <HistoryEntry key={entryKey(entry)} entry={entry} jumpable={entry.action !== "delete" && onBoard.has(entry.nodeId)} />
                    ))}
                  </ul>
                </li>
              );
            })}
          </ol>
        )}
      </div>

      {status === "ready" && next && (
        <footer className="border-t border-line px-4 py-2">
          <button
            type="button"
            onClick={() => void loadOlder()}
            disabled={loadingOlder}
            className="flex w-full items-center justify-center gap-1.5 rounded-lg py-1.5 text-xs font-semibold text-white/70 outline-none hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-50"
          >
            {loadingOlder && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Load older changes
          </button>
        </footer>
      )}
    </section>
  );
}

function HistoryEntry({ entry, jumpable }) {
  const Icon = ACTION_ICONS[entry.action] ?? Pencil;
  const body = (
    <>
      <Icon aria-hidden className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", entry.action === "delete" ? "text-red-300/80" : "text-white/50")} />
      <span className="min-w-0 flex-1">
        <span className="block text-xs text-white/80">{describeChange(entry)}</span>
        {entry.snippet && <span className="block truncate text-xs text-white/45">“{entry.snippet}”</span>}
      </span>
      <time dateTime={new Date(entry.at).toISOString()} className="shrink-0 text-[11px] text-white/40">
        {formatTime(entry.at)}
      </time>
    </>
  );
  if (!jumpable) {
    return (
      <li className="flex items-start gap-2 rounded-lg px-2 py-1.5" title={entry.action === "delete" ? undefined : "No longer on the board"}>
        {body}
      </li>
    );
  }
  return (
    <li>
      <button
        type="button"
        onClick={() => useCanvasStore.getState().focusObject(entry.nodeId)}
        className="flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left outline-none hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-brand"
      >
        {body}
      </button>
    </li>
  );
}
