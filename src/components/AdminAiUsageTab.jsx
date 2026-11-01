"use client";

import { useEffect, useState } from "react";
import { formatCost } from "@/lib/format-cost";
import { fetchUsage } from "@/lib/sidekick-api";

const PERIODS = [
  { id: "day", label: "Daily" },
  { id: "week", label: "Weekly" },
  { id: "month", label: "Monthly" },
  { id: "quarter", label: "Quarterly" },
];

/** Board AI credit usage: spend and job counts per period, per action and (unless hidden) per person. */
export function AdminAiUsageTab() {
  const [period, setPeriod] = useState("month");
  const [hideUsers, setHideUsers] = useState(false);
  const [usage, setUsage] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let live = true;
    setError(null);
    fetchUsage({ period, hideUsers }).then((value) => live && setUsage(value)).catch((e) => live && setError(e.message));
    return () => { live = false; };
  }, [period, hideUsers]);

  const max = Math.max(1, ...(usage?.periods ?? []).map((row) => row.costCents));
  return (
    <div className="space-y-5" aria-label="AI usage">
      <div className="flex flex-wrap items-center gap-3 text-sm text-white/70">
        <div role="radiogroup" aria-label="Period" className="flex gap-1 rounded-lg bg-ink-800 p-0.5">
          {PERIODS.map((item) => (
            <button key={item.id} type="button" role="radio" aria-checked={period === item.id} onClick={() => setPeriod(item.id)} className={`rounded-md px-3 py-1 text-xs font-medium ${period === item.id ? "bg-ink-650 text-white" : "text-white/55 hover:text-white"}`}>{item.label}</button>
          ))}
        </div>
        <label className="flex items-center gap-1.5 text-xs"><input type="checkbox" checked={hideUsers} onChange={(e) => setHideUsers(e.target.checked)} />Hide people (anonymous totals)</label>
        {usage && <span className="ml-auto text-xs text-white/55">Total in the last {usage.days} days: <strong className="text-white/90">{formatCost(usage.totalCents)}</strong>. Amounts are in the application&apos;s estimator cents.</span>}
      </div>
      {error && <p role="alert" className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-300">{error}</p>}
      {usage && (
        <>
          <section aria-label="Spend by period">
            <h3 className="mb-2 text-sm font-medium text-white/80">Spend by period</h3>
            {usage.periods.length === 0 ? <p className="text-sm text-white/45">No board AI jobs in this time.</p> : (
              <ul className="space-y-1">
                {usage.periods.map((row) => (
                  <li key={row.start} className="flex items-center gap-3 text-xs text-white/70">
                    <span className="w-24 shrink-0 tabular-nums">{row.start}</span>
                    <span className="h-2 flex-1 overflow-hidden rounded bg-ink-800"><span className="block h-full rounded bg-brand" style={{ width: `${(row.costCents / max) * 100}%` }} /></span>
                    <span className="w-28 shrink-0 text-right tabular-nums">{formatCost(row.costCents)} · {row.jobs} jobs</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section aria-label="Spend by action">
            <h3 className="mb-2 text-sm font-medium text-white/80">By action</h3>
            <Table rows={usage.formats.map((row) => [row.format, row.format, row.jobs, row.costCents])} head="Action" />
          </section>
          {usage.users && (
            <section aria-label="Spend by person">
              <h3 className="mb-2 text-sm font-medium text-white/80">By person</h3>
              <Table rows={usage.users.map((row) => [row.id, row.name, row.jobs, row.costCents])} head="Person" />
            </section>
          )}
        </>
      )}
    </div>
  );
}

function Table({ rows, head }) {
  if (!rows.length) return <p className="text-sm text-white/45">Nothing yet.</p>;
  return (
    <table className="w-full text-left text-xs text-white/70">
      <thead className="text-white/45"><tr><th className="py-1 font-medium">{head}</th><th className="py-1 text-right font-medium">Jobs</th><th className="py-1 text-right font-medium">Spend</th></tr></thead>
      <tbody>{rows.map(([key, name, jobs, cents]) => <tr key={key} className="border-t border-line"><td className="py-1.5">{name}</td><td className="py-1.5 text-right tabular-nums">{jobs}</td><td className="py-1.5 text-right tabular-nums">{formatCost(cents)}</td></tr>)}</tbody>
    </table>
  );
}
