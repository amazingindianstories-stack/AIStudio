"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, ChevronRight, Copy } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  dayEnd,
  dayStart,
  errorText,
  errorTime,
  formatIst,
  formatUtc,
  providerLabel,
  providerShort,
  supportBlock,
} from "@/lib/admin-errors";

const PAGE_SIZE = 50;

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Older browsers and non-secure origins: a hidden textarea and the copy command.
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    let copied = false;
    try {
      copied = document.execCommand("copy");
    } catch {
      copied = false;
    }
    area.remove();
    return copied;
  }
}

function CopyButton({ row }) {
  const [state, setState] = useState("idle");
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async (event) => {
    event.stopPropagation();
    const copied = await copyText(supportBlock(row));
    setState(copied ? "copied" : "failed");
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 1600);
  };
  return (
    <button
      type="button"
      onClick={copy}
      aria-label="Copy support details"
      title="Copy the code, request id, time (UTC and IST) and model for provider support"
      className={cn(
        "inline-flex min-w-[84px] items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border px-2 py-1 text-xs transition",
        state === "copied"
          ? "border-emerald-400/35 bg-emerald-500/10 text-emerald-300"
          : state === "failed"
            ? "border-red-400/35 bg-red-500/10 text-red-300"
            : "border-line bg-ink-700 text-white/70 hover:text-white"
      )}
    >
      {state === "copied" ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      {state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy"}
    </button>
  );
}

function Fact({ label, children, mono = false }) {
  if (children === null || children === undefined || children === "") return null;
  return (
    <div className="min-w-0">
      <dt className="text-[10px] uppercase tracking-wide text-white/35">{label}</dt>
      <dd className={cn("mt-0.5 break-words text-xs text-white/75", mono && "font-mono")}>{children}</dd>
    </div>
  );
}

function ErrorDetail({ row }) {
  const time = errorTime(row);
  const earlier = (row.records || []).length > 1 ? row.records.length - 1 : 0;
  return (
    <div className="space-y-3 px-3 pb-4 pt-1">
      {row.userMessage && (
        <div className="rounded-lg border border-line bg-ink-900/60 px-3 py-2">
          <p className="text-[10px] uppercase tracking-wide text-white/35">What the user saw</p>
          <p className="mt-0.5 text-xs leading-5 text-white/75">{row.userMessage}</p>
        </div>
      )}
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
        <Fact label="Error code" mono>{row.code}</Fact>
        <Fact label="Provider">{providerLabel(row.provider)}</Fact>
        <Fact label="HTTP status">{row.httpStatus}</Fact>
        <Fact label="Param" mono>{row.param}</Fact>
        <Fact label="Phase">{row.phase}</Fact>
        <Fact label={row.source === "portrait" ? "Asset id" : "Task id"} mono>{row.taskId}</Fact>
        <Fact label="Request id" mono>{row.requestId}</Fact>
        <Fact label="Time (UTC)">{formatUtc(time)}</Fact>
        <Fact label="Time (IST)">{formatIst(time)}</Fact>
        <Fact label={row.source === "portrait" ? "Portrait asset" : "Generation id"} mono>{row.id}</Fact>
        <Fact label="Status">{row.status}</Fact>
        <Fact label="Recorded by">{row.origin === "veevee" ? "Veevee (no provider answer)" : row.origin ? "Provider answer" : null}</Fact>
        {earlier > 0 && <Fact label="Other records">{`${earlier} more (best-of candidates or earlier attempts)`}</Fact>}
      </dl>
      <Fact label="Provider message">{row.message}</Fact>
      {row.error && row.error !== row.message && (
        <Fact label="Stored error">{row.error}</Fact>
      )}
      {row.rawBody ? (
        <div>
          <p className="mb-1 text-[10px] uppercase tracking-wide text-white/35">Raw provider response</p>
          <pre className="scroll-thin max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-line bg-ink-900/60 p-3 font-mono text-[11px] leading-4 text-white/65">
            {row.rawBody}
          </pre>
        </div>
      ) : (
        <p className="text-xs text-white/40">No raw provider response was stored for this error.</p>
      )}
    </div>
  );
}

export function AdminErrorsTab({ data, usersById }) {
  const [user, setUser] = useState("");
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [source, setSource] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [code, setCode] = useState("");

  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [providers, setProviders] = useState([]);
  const [models, setModels] = useState([]);
  const [nextCursor, setNextCursor] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(() => new Set());
  // The scroll area's visible width: an expanded row's details pin to it, so they never widen the table or hide
  // off-screen on a phone.
  const scroller = useRef(null);
  const [visibleWidth, setVisibleWidth] = useState(null);
  useEffect(() => {
    const node = scroller.current;
    if (!node || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(() => setVisibleWidth(node.clientWidth));
    observer.observe(node);
    setVisibleWidth(node.clientWidth);
    return () => observer.disconnect();
  }, []);

  const params = useMemo(() => {
    const p = new URLSearchParams();
    if (user) p.set("userId", user);
    if (provider) p.set("provider", provider);
    if (model) p.set("model", model);
    if (source) p.set("source", source);
    const start = dayStart(from);
    const end = dayEnd(to);
    if (start !== null) p.set("from", String(start));
    if (end !== null) p.set("to", String(end));
    if (code.trim()) p.set("code", code.trim());
    p.set("limit", String(PAGE_SIZE));
    return p.toString();
  }, [user, provider, model, source, from, to, code]);

  // The same refetch discipline as the Logs tab: drop the stale cursor first,
  // debounce typing, and let only the newest reply paint.
  const seq = useRef(0);
  useEffect(() => {
    const mine = ++seq.current;
    setLoading(true);
    setNextCursor(null);
    const timer = setTimeout(async () => {
      try {
        const res = await apiFetch(`/api/admin/errors?${params}`, { cache: "no-store" });
        if (mine !== seq.current) return;
        if (!res.ok) {
          setFailed(true);
          return;
        }
        const page = await res.json();
        if (mine !== seq.current) return;
        setFailed(false);
        setRows(page.rows);
        setTotal(page.total);
        setNextCursor(page.nextCursor);
        // First-page lists, unfiltered: the dropdowns keep every choice.
        if (page.providers) setProviders(page.providers);
        if (page.models) setModels(page.models);
      } catch {
        if (mine === seq.current) setFailed(true);
      } finally {
        if (mine === seq.current) setLoading(false);
      }
    }, code.trim() ? 300 : 0);
    return () => clearTimeout(timer);
  }, [params, code]);

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    const mine = seq.current;
    setLoadingMore(true);
    try {
      const res = await apiFetch(`/api/admin/errors?${params}&cursor=${encodeURIComponent(nextCursor)}`, { cache: "no-store" });
      if (!res.ok) return;
      const page = await res.json();
      if (mine !== seq.current) return;
      setRows((prev) => [...prev, ...page.rows]);
      setNextCursor(page.nextCursor);
    } finally {
      setLoadingMore(false);
    }
  };

  const toggle = (id) =>
    setOpen((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const sel =
    "rounded-lg border border-line bg-ink-700 px-2.5 py-1.5 text-sm outline-none focus:border-brand/40";
  const userName = (row) =>
    usersById[row.userId || ""]?.name || row.userEmail || usersById[row.userId || ""]?.email || "-";

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <select value={user} onChange={(e) => setUser(e.target.value)} className={cn(sel, "w-full sm:w-auto")} aria-label="User">
          <option value="">All users</option>
          {data.users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name || u.email}
            </option>
          ))}
        </select>
        <select value={provider} onChange={(e) => setProvider(e.target.value)} className={cn(sel, "min-w-0 flex-1 sm:w-auto sm:flex-none")} aria-label="Provider">
          <option value="">All providers</option>
          {providers.map((p) => (
            <option key={p} value={p}>
              {providerLabel(p)}
            </option>
          ))}
        </select>
        <select value={model} onChange={(e) => setModel(e.target.value)} className={cn(sel, "min-w-0 flex-1 sm:w-auto sm:flex-none")} aria-label="Model">
          <option value="">All models</option>
          {models.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
          <option value="Portrait asset">Portrait asset</option>
        </select>
        <select value={source} onChange={(e) => setSource(e.target.value)} className={cn(sel, "w-full sm:w-auto")} aria-label="Source">
          <option value="">Generations and portraits</option>
          <option value="generation">Generations only</option>
          <option value="portrait">Portrait assets only</option>
        </select>
        <div className="flex w-full items-center gap-2 sm:w-auto">
          <label className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-white/45 sm:flex-none">
            From
            <input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)}
              className={cn(sel, "min-w-0 flex-1 [color-scheme:dark]")} aria-label="From date" />
          </label>
          <label className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-white/45 sm:flex-none">
            To
            <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)}
              className={cn(sel, "min-w-0 flex-1 [color-scheme:dark]")} aria-label="To date" />
          </label>
        </div>
        <input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="Search error code…"
          aria-label="Error code"
          className={cn(sel, "w-full sm:w-auto sm:min-w-[180px] sm:flex-1")}
        />
      </div>

      <p className="text-xs text-white/40">
        {loading
          ? "Loading…"
          : failed
            ? "Errors could not be loaded. Try again."
            : `Showing ${rows.length.toLocaleString()} of ${total.toLocaleString()} errors`}
      </p>

      <div ref={scroller} className="scroll-thin relative overflow-x-auto rounded-xl border border-line">
        <table className="block w-full text-sm sm:table sm:min-w-[900px]">
          <thead className="hidden bg-ink-800 text-left sm:table-header-group text-xs uppercase tracking-wide text-white/40">
            <tr>
              <th className="px-3 py-2">Time</th>
              <th className="px-3 py-2">User</th>
              <th className="px-3 py-2">Model</th>
              <th className="px-3 py-2">Error</th>
              <th className="px-3 py-2">Request id</th>
              <th className="px-3 py-2" aria-label="Support" />
            </tr>
          </thead>
          <tbody className="grid sm:table-row-group">
            {rows.map((row) => {
              const expanded = open.has(row.id);
              const time = errorTime(row);
              return (
                <Fragment key={row.id}>
                  <tr
                    className={cn("mt-3 grid min-w-0 grid-cols-[minmax(0,1fr)_auto] cursor-pointer rounded-lg border border-line align-top transition first:mt-0 hover:bg-white/[0.02] sm:mt-0 sm:table-row sm:rounded-none sm:border-0 sm:border-t", expanded && "rounded-b-none border-b-0 bg-white/[0.02]")}
                    onClick={() => toggle(row.id)}
                  >
                    <td className="col-span-2 px-3 py-2 text-xs text-white/55 sm:whitespace-nowrap" title={`${formatUtc(time)}\n${formatIst(time)}`}>
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          toggle(row.id);
                        }}
                        aria-expanded={expanded}
                        aria-label={expanded ? "Hide error details" : "Show error details"}
                        className="flex items-center gap-1 text-left hover:text-white"
                      >
                        {expanded ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
                        {new Date(time).toLocaleString()}
                      </button>
                    </td>
                    <td className="col-span-2 break-words px-3 py-2 text-xs sm:max-w-[150px] sm:truncate" title={row.userEmail || ""}>
                      {userName(row)}
                    </td>
                    <td className="col-span-2 break-words px-3 py-2 text-xs sm:whitespace-nowrap">
                      <p>{row.model}</p>
                      <p className="mt-0.5 text-[11px] text-white/40">{providerShort(row.provider)}</p>
                    </td>
                    <td className="col-span-2 min-w-0 w-full px-3 py-2 text-xs sm:max-w-0">
                      <p className="flex min-w-0 flex-wrap items-baseline gap-1.5 sm:flex-nowrap">
                        {row.code ? (
                          <span className="break-all font-mono text-red-300 sm:truncate" title={row.code}>{row.code}</span>
                        ) : (
                          !row.httpStatus && <span className="text-white/35">No provider code</span>
                        )}
                        {row.httpStatus && (
                          <span className="shrink-0 rounded bg-white/[0.06] px-1 font-mono text-[10px] text-white/50">HTTP {row.httpStatus}</span>
                        )}
                      </p>
                      <p className="mt-0.5 break-words text-white/60 sm:line-clamp-2" title={errorText(row)}>
                        {errorText(row) || <span className="text-white/25">-</span>}
                      </p>
                    </td>
                    <td className="min-w-0 break-all px-3 py-2 font-mono text-[11px] text-white/55 sm:max-w-[230px] sm:truncate" title={row.requestId || ""}>
                      {row.requestId || <span className="font-sans text-white/25">-</span>}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <CopyButton row={row} />
                    </td>
                  </tr>
                  {expanded && (
                    <tr className="block rounded-b-lg border border-t-0 border-line bg-white/[0.02] sm:table-row sm:rounded-none sm:border-0">
                      <td colSpan={6} className="block p-0 sm:table-cell">
                        <div className="sticky left-0 max-w-full" style={visibleWidth ? { width: visibleWidth } : undefined}>
                          <ErrorDetail row={row} />
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
            {!loading && !failed && rows.length === 0 && (
              <tr className="border-t border-line">
                <td colSpan={6} className="px-3 py-8 text-center text-xs text-white/40">
                  No provider errors match these filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {nextCursor && (
        <button
          onClick={loadMore}
          disabled={loadingMore}
          className="w-full rounded-lg border border-line bg-ink-700 px-3 py-2 text-sm text-white/70 hover:text-white disabled:opacity-50"
        >
          {loadingMore ? "Loading…" : `Load ${Math.min(PAGE_SIZE, Math.max(0, total - rows.length))} more`}
        </button>
      )}
    </div>
  );
}
