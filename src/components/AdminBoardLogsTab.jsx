"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { apiErrorMessage } from "@/lib/api-error";

const LOGS = {
  content: {
    label: "Content log",
    path: "/api/admin/content-log",
    columns: [
      ["Time", (r) => new Date(r.createdAt).toLocaleString()],
      ["Board", (r) => r.boardId],
      ["User", (r) => r.actorId || "-"],
      ["Action", (r) => r.action],
      ["Item", (r) => [r.nodeType, r.snippet].filter(Boolean).join(": ")],
    ],
  },
  ai: {
    label: "AI interaction log",
    path: "/api/admin/ai-log",
    columns: [
      ["Time", (r) => new Date(r.createdAt).toLocaleString()],
      ["Board", (r) => r.boardId],
      ["User", (r) => r.userId],
      ["Capability", (r) => r.capability],
      ["Model", (r) => r.model || "-"],
      ["Status", (r) => r.status],
      ["Cost", (r) => (r.costCents == null ? "-" : `${r.costCents}c`)],
    ],
  },
};

/** Admin view of board content and AI logs, paged by keyset with a streamed CSV download. */
export function AdminBoardLogsTab() {
  const [kind, setKind] = useState("content");
  const [rows, setRows] = useState([]);
  const [next, setNext] = useState(null);
  const [state, setState] = useState("Loading...");
  const log = LOGS[kind];

  const load = useCallback(
    async (cursor) => {
      setState("Loading...");
      try {
        const res = await apiFetch(`${log.path}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`);
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(apiErrorMessage(json, res.status, "Could not load the log."));
        setRows((old) => (cursor ? [...old, ...json.rows] : json.rows));
        setNext(json.nextCursor);
        setState("");
      } catch (error) {
        setState(error.message);
      }
    },
    [log.path]
  );

  useEffect(() => {
    setRows([]);
    setNext(null);
    load(null);
  }, [load]);

  return (
    <section aria-label="Board logs" className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {Object.entries(LOGS).map(([id, item]) => (
          <button
            key={id}
            aria-pressed={kind === id}
            onClick={() => setKind(id)}
            className={`rounded-lg px-3 py-1.5 text-sm ${kind === id ? "bg-ink-650 text-white" : "text-white/55 hover:text-white"}`}
          >
            {item.label}
          </button>
        ))}
        <a href={`${log.path}?format=csv`} className="ml-auto rounded-lg bg-ink-700 px-3 py-1.5 text-sm text-white/80 hover:text-white">
          Download CSV
        </a>
      </div>
      {state && <p className="text-sm text-white/50">{state}</p>}
      <div className="overflow-x-auto rounded-xl bg-ink-800">
        <table className="w-full text-left text-xs text-white/75">
          <thead className="text-white/45">
            <tr>
              {log.columns.map(([title]) => (
                <th key={title} className="px-3 py-2 font-medium">{title}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-t border-white/5">
                {log.columns.map(([title, cell]) => (
                  <td key={title} className="max-w-[16rem] truncate px-3 py-2">{cell(row)}</td>
                ))}
              </tr>
            ))}
            {!rows.length && !state && (
              <tr><td colSpan={log.columns.length} className="px-3 py-6 text-center text-white/40">No entries yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      {next && (
        <button onClick={() => load(next)} className="rounded-lg bg-ink-700 px-3 py-1.5 text-sm text-white/80 hover:text-white">
          Load more
        </button>
      )}
    </section>
  );
}
