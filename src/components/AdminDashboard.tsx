"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  LineChart,
  Line,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from "recharts";
import {
  ArrowLeft,
  Users as UsersIcon,
  ScrollText,
  LayoutDashboard,
  DollarSign,
  Plus,
  Trash2,
  KeyRound,
  Download,
} from "lucide-react";
import { formatCost } from "@/lib/pricing";
import { cn } from "@/lib/utils";

interface AdminUser {
  id: string;
  email: string;
  name: string;
  role: string;
  color: string | null;
  isActive: boolean;
  createdAt: number;
  genCount: number;
  costCents: number;
}
interface LogRow {
  id: string;
  kind: string;
  model: string;
  status: string;
  costCents: number;
  userId: string | null;
  prompt: string;
  createdAt: number;
}
interface PricingRow {
  model: string;
  unitCostCents: number;
  unit: string;
  notes?: string | null;
}
interface Data {
  users: AdminUser[];
  generations: LogRow[];
  pricing: PricingRow[];
}

type Tab = "overview" | "users" | "logs" | "pricing";
const CHART_COLORS = ["#34d399", "#60a5fa", "#f472b6", "#fbbf24", "#a78bfa", "#f87171"];

export function AdminDashboard() {
  const [data, setData] = useState<Data | null>(null);
  const [tab, setTab] = useState<Tab>("overview");

  const load = async () => {
    const res = await fetch("/api/admin/data", { cache: "no-store" });
    if (res.ok) setData(await res.json());
  };
  useEffect(() => {
    load();
  }, []);

  const usersById = useMemo(() => {
    const m: Record<string, AdminUser> = {};
    for (const u of data?.users ?? []) m[u.id] = u;
    return m;
  }, [data]);

  return (
    <div className="min-h-[100dvh] bg-ink-900 text-white">
      <header className="flex h-14 items-center gap-3 border-b border-line px-4">
        <a
          href="/"
          className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm text-white/70 hover:bg-white/5 hover:text-white"
        >
          <ArrowLeft className="h-4 w-4" /> Back to app
        </a>
        <span className="text-sm font-semibold">Admin</span>
      </header>

      <div className="mx-auto max-w-6xl p-4 sm:p-6">
        {/* tabs */}
        <div className="mb-5 flex gap-1 rounded-xl bg-ink-800 p-1">
          {(
            [
              ["overview", "Overview", LayoutDashboard],
              ["users", "Users", UsersIcon],
              ["logs", "Logs", ScrollText],
              ["pricing", "Pricing", DollarSign],
            ] as const
          ).map(([id, label, Icon]) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={cn(
                "flex flex-1 items-center justify-center gap-1.5 rounded-lg py-2 text-sm font-medium transition",
                tab === id ? "bg-ink-650 text-white" : "text-white/55 hover:text-white"
              )}
            >
              <Icon className="h-4 w-4" /> {label}
            </button>
          ))}
        </div>

        {!data ? (
          <p className="py-20 text-center text-white/40">Loading…</p>
        ) : tab === "overview" ? (
          <Overview data={data} />
        ) : tab === "users" ? (
          <UsersTab data={data} reload={load} />
        ) : tab === "logs" ? (
          <LogsTab data={data} usersById={usersById} />
        ) : (
          <PricingTab data={data} reload={load} />
        )}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-line bg-ink-800 p-4">
      <p className="text-xs uppercase tracking-wide text-white/40">{label}</p>
      <p className="mt-1 text-2xl font-semibold">{value}</p>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-line bg-ink-800 p-4">
      <p className="mb-3 text-sm font-medium text-white/70">{title}</p>
      {children}
    </div>
  );
}

function Overview({ data }: { data: Data }) {
  const totalCost = data.generations.reduce((s, g) => s + g.costCents, 0);
  const costPerUser = data.users
    .filter((u) => u.genCount > 0)
    .map((u) => ({ name: u.name || u.email, cost: u.costCents / 100, color: u.color || "#34d399" }));

  const byType = (["image", "video"] as const).map((k) => ({
    name: k,
    value: data.generations.filter((g) => g.kind === k).length,
  }));

  const byModelMap: Record<string, number> = {};
  for (const g of data.generations) byModelMap[g.model] = (byModelMap[g.model] || 0) + 1;
  const byModel = Object.entries(byModelMap).map(([name, value]) => ({ name, value }));

  const overTimeMap: Record<string, number> = {};
  for (const g of data.generations) {
    const day = new Date(g.createdAt).toISOString().slice(0, 10);
    overTimeMap[day] = (overTimeMap[day] || 0) + 1;
  }
  const overTime = Object.entries(overTimeMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, count]) => ({ day: day.slice(5), count }));

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Total spend" value={formatCost(totalCost)} />
        <Stat label="Generations" value={String(data.generations.length)} />
        <Stat label="Users" value={String(data.users.length)} />
        <Stat
          label="Avg / generation"
          value={formatCost(
            data.generations.length ? Math.round(totalCost / data.generations.length) : 0
          )}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel title="Cost per user ($)">
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={costPerUser}>
              <CartesianGrid strokeDasharray="3 3" stroke="#ffffff14" />
              <XAxis dataKey="name" stroke="#ffffff66" fontSize={11} />
              <YAxis stroke="#ffffff66" fontSize={11} />
              <Tooltip contentStyle={TOOLTIP} />
              <Bar dataKey="cost" radius={[4, 4, 0, 0]}>
                {costPerUser.map((u, i) => (
                  <Cell key={i} fill={u.color} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </Panel>

        <Panel title="Generations over time">
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={overTime}>
              <CartesianGrid strokeDasharray="3 3" stroke="#ffffff14" />
              <XAxis dataKey="day" stroke="#ffffff66" fontSize={11} />
              <YAxis stroke="#ffffff66" fontSize={11} allowDecimals={false} />
              <Tooltip contentStyle={TOOLTIP} />
              <Line type="monotone" dataKey="count" stroke="#34d399" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </Panel>

        <Panel title="By type">
          <ResponsiveContainer width="100%" height={240}>
            <PieChart>
              <Pie data={byType} dataKey="value" nameKey="name" outerRadius={90} label>
                {byType.map((_, i) => (
                  <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                ))}
              </Pie>
              <Tooltip contentStyle={TOOLTIP} />
            </PieChart>
          </ResponsiveContainer>
        </Panel>

        <Panel title="By model">
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={byModel}>
              <CartesianGrid strokeDasharray="3 3" stroke="#ffffff14" />
              <XAxis dataKey="name" stroke="#ffffff66" fontSize={11} />
              <YAxis stroke="#ffffff66" fontSize={11} allowDecimals={false} />
              <Tooltip contentStyle={TOOLTIP} />
              <Bar dataKey="value" fill="#60a5fa" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </Panel>
      </div>
    </div>
  );
}

const TOOLTIP = {
  background: "#15151a",
  border: "1px solid #ffffff1a",
  borderRadius: 8,
  fontSize: 12,
};

function UsersTab({ data, reload }: { data: Data; reload: () => void }) {
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ email: "", password: "", name: "", role: "user" });

  const create = async () => {
    const res = await fetch("/api/admin/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    if (res.ok) {
      setForm({ email: "", password: "", name: "", role: "user" });
      setAdding(false);
      reload();
    } else {
      alert((await res.json()).error || "Failed");
    }
  };

  const patch = async (id: string, body: Record<string, unknown>) => {
    await fetch("/api/admin/users", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, ...body }),
    });
    reload();
  };

  const resetPw = async (id: string) => {
    const pw = window.prompt("New password");
    if (pw) await patch(id, { password: pw });
  };

  const del = async (id: string) => {
    if (!window.confirm("Delete this user?")) return;
    const res = await fetch(`/api/admin/users?id=${id}`, { method: "DELETE" });
    if (!res.ok) alert((await res.json()).error || "Failed");
    reload();
  };

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <button
          onClick={() => setAdding((v) => !v)}
          className="flex items-center gap-1.5 rounded-lg bg-brand/20 px-3 py-1.5 text-sm font-semibold text-brand hover:bg-brand/30"
        >
          <Plus className="h-4 w-4" /> New user
        </button>
      </div>

      {adding && (
        <div className="grid grid-cols-1 gap-2 rounded-xl border border-line bg-ink-800 p-3 sm:grid-cols-5">
          <input
            placeholder="Email"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
            className="rounded-lg border border-line bg-ink-700 px-2.5 py-2 text-sm outline-none focus:border-brand/40"
          />
          <input
            placeholder="Name"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            className="rounded-lg border border-line bg-ink-700 px-2.5 py-2 text-sm outline-none focus:border-brand/40"
          />
          <input
            placeholder="Password"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            className="rounded-lg border border-line bg-ink-700 px-2.5 py-2 text-sm outline-none focus:border-brand/40"
          />
          <select
            value={form.role}
            onChange={(e) => setForm({ ...form, role: e.target.value })}
            className="rounded-lg border border-line bg-ink-700 px-2.5 py-2 text-sm outline-none focus:border-brand/40"
          >
            <option value="user">user</option>
            <option value="admin">admin</option>
          </select>
          <button
            onClick={create}
            disabled={!form.email || !form.password}
            className="rounded-lg bg-brand py-2 text-sm font-semibold text-ink-900 disabled:opacity-50"
          >
            Create
          </button>
        </div>
      )}

      <div className="overflow-hidden rounded-xl border border-line">
        <table className="w-full text-sm">
          <thead className="bg-ink-800 text-left text-xs uppercase tracking-wide text-white/40">
            <tr>
              <th className="px-3 py-2">User</th>
              <th className="px-3 py-2">Role</th>
              <th className="px-3 py-2">Gens</th>
              <th className="px-3 py-2">Cost</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {data.users.map((u) => (
              <tr key={u.id} className="border-t border-line">
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span
                      className="grid h-6 w-6 place-items-center rounded-full text-[11px] font-semibold text-ink-900"
                      style={{ background: u.color || "#34d399" }}
                    >
                      {(u.name || u.email).charAt(0).toUpperCase()}
                    </span>
                    <div>
                      <p className="font-medium">{u.name}</p>
                      <p className="text-xs text-white/40">{u.email}</p>
                    </div>
                  </div>
                </td>
                <td className="px-3 py-2">
                  <select
                    value={u.role}
                    onChange={(e) => patch(u.id, { role: e.target.value })}
                    className="rounded bg-ink-700 px-1.5 py-1 text-xs"
                  >
                    <option value="user">user</option>
                    <option value="admin">admin</option>
                  </select>
                </td>
                <td className="px-3 py-2 tabular-nums">{u.genCount}</td>
                <td className="px-3 py-2 tabular-nums">{formatCost(u.costCents)}</td>
                <td className="px-3 py-2">
                  <button
                    onClick={() => patch(u.id, { isActive: !u.isActive })}
                    className={cn(
                      "rounded px-2 py-0.5 text-xs font-medium",
                      u.isActive
                        ? "bg-emerald-500/15 text-emerald-300"
                        : "bg-white/10 text-white/50"
                    )}
                  >
                    {u.isActive ? "active" : "disabled"}
                  </button>
                </td>
                <td className="px-3 py-2">
                  <div className="flex justify-end gap-1">
                    <button
                      onClick={() => resetPw(u.id)}
                      title="Reset password"
                      className="grid h-7 w-7 place-items-center rounded text-white/55 hover:bg-white/10 hover:text-white"
                    >
                      <KeyRound className="h-3.5 w-3.5" />
                    </button>
                    <button
                      onClick={() => del(u.id)}
                      title="Delete"
                      className="grid h-7 w-7 place-items-center rounded text-white/55 hover:bg-red-500/15 hover:text-red-300"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function LogsTab({
  data,
  usersById,
}: {
  data: Data;
  usersById: Record<string, AdminUser>;
}) {
  const [user, setUser] = useState("");
  const [kind, setKind] = useState("");
  const [model, setModel] = useState("");
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");

  const models = useMemo(
    () => Array.from(new Set(data.generations.map((g) => g.model))),
    [data]
  );

  const rows = useMemo(() => {
    const ql = q.trim().toLowerCase();
    return data.generations
      .filter((g) => (user ? g.userId === user : true))
      .filter((g) => (kind ? g.kind === kind : true))
      .filter((g) => (model ? g.model === model : true))
      .filter((g) => (status ? g.status === status : true))
      .filter((g) => (ql ? g.prompt.toLowerCase().includes(ql) : true));
  }, [data, user, kind, model, status, q]);

  const exportCsv = () => {
    const head = ["time", "user", "kind", "model", "status", "cost", "prompt"];
    const lines = rows.map((g) =>
      [
        new Date(g.createdAt).toISOString(),
        usersById[g.userId || ""]?.email || "—",
        g.kind,
        g.model,
        g.status,
        formatCost(g.costCents),
        `"${g.prompt.replace(/"/g, '""')}"`,
      ].join(",")
    );
    const blob = new Blob([[head.join(","), ...lines].join("\n")], {
      type: "text/csv",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "lumina-logs.csv";
    a.click();
  };

  const sel =
    "rounded-lg border border-line bg-ink-700 px-2.5 py-1.5 text-sm outline-none focus:border-brand/40";

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <select value={user} onChange={(e) => setUser(e.target.value)} className={sel}>
          <option value="">All users</option>
          {data.users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name || u.email}
            </option>
          ))}
        </select>
        <select value={kind} onChange={(e) => setKind(e.target.value)} className={sel}>
          <option value="">All types</option>
          <option value="image">image</option>
          <option value="video">video</option>
        </select>
        <select value={model} onChange={(e) => setModel(e.target.value)} className={sel}>
          <option value="">All models</option>
          {models.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value)} className={sel}>
          <option value="">All statuses</option>
          <option value="succeeded">succeeded</option>
          <option value="running">running</option>
          <option value="queued">queued</option>
          <option value="failed">failed</option>
        </select>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search prompt…"
          className={cn(sel, "flex-1")}
        />
        <button
          onClick={exportCsv}
          className="flex items-center gap-1.5 rounded-lg border border-line bg-ink-700 px-3 py-1.5 text-sm text-white/80 hover:text-white"
        >
          <Download className="h-4 w-4" /> CSV
        </button>
      </div>

      <p className="text-xs text-white/40">{rows.length} entries</p>

      <div className="overflow-hidden rounded-xl border border-line">
        <table className="w-full text-sm">
          <thead className="bg-ink-800 text-left text-xs uppercase tracking-wide text-white/40">
            <tr>
              <th className="px-3 py-2">Time</th>
              <th className="px-3 py-2">User</th>
              <th className="px-3 py-2">Type</th>
              <th className="px-3 py-2">Model</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Cost</th>
              <th className="px-3 py-2">Prompt</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 500).map((g) => (
              <tr key={g.id} className="border-t border-line align-top">
                <td className="whitespace-nowrap px-3 py-2 text-xs text-white/55">
                  {new Date(g.createdAt).toLocaleString()}
                </td>
                <td className="px-3 py-2 text-xs">
                  {usersById[g.userId || ""]?.name || "—"}
                </td>
                <td className="px-3 py-2">{g.kind}</td>
                <td className="px-3 py-2 text-xs">{g.model}</td>
                <td className="px-3 py-2 text-xs">{g.status}</td>
                <td className="px-3 py-2 tabular-nums">{formatCost(g.costCents)}</td>
                <td className="max-w-[280px] truncate px-3 py-2 text-xs text-white/60">
                  {g.prompt}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PricingTab({ data, reload }: { data: Data; reload: () => void }) {
  const save = async (model: string, unitCostCents: number, unit: string) => {
    await fetch("/api/admin/pricing", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, unitCostCents, unit }),
    });
    reload();
  };
  return (
    <div className="space-y-2">
      <p className="text-xs text-white/45">
        Cost applied to each generation (in cents). Images: per image (scaled by
        resolution). Videos: per second × duration.
      </p>
      <div className="overflow-hidden rounded-xl border border-line">
        <table className="w-full text-sm">
          <thead className="bg-ink-800 text-left text-xs uppercase tracking-wide text-white/40">
            <tr>
              <th className="px-3 py-2">Model</th>
              <th className="px-3 py-2">Unit</th>
              <th className="px-3 py-2">Cost (cents)</th>
            </tr>
          </thead>
          <tbody>
            {data.pricing.map((p) => (
              <tr key={p.model} className="border-t border-line">
                <td className="px-3 py-2 font-medium">{p.model}</td>
                <td className="px-3 py-2 text-xs text-white/55">{p.unit}</td>
                <td className="px-3 py-2">
                  <input
                    type="number"
                    defaultValue={p.unitCostCents}
                    onBlur={(e) =>
                      save(p.model, Number(e.target.value), p.unit)
                    }
                    className="w-24 rounded-lg border border-line bg-ink-700 px-2 py-1 text-sm outline-none focus:border-brand/40"
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
