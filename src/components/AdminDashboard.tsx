"use client";

import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type RefObject } from "react";
import { AnimatePresence, motion } from "framer-motion";
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
  CheckCircle2,
  Loader2,
  UserCheck,
  UserX,
  X,
  Settings,
} from "lucide-react";
import { formatCost } from "@/lib/pricing";
import { cn } from "@/lib/utils";
import { AccountSettings } from "./AccountSettings";

interface AdminUser {
  id: string;
  email: string;
  name: string;
  role: string;
  color: string | null;
  avatarUrl: string | null;
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
interface ActivityRow {
  id: string;
  userId: string | null;
  action: string;
  detail: Record<string, unknown> | null;
  createdAt: number;
}
interface Data {
  users: AdminUser[];
  generations: LogRow[];
  activity: ActivityRow[];
  pricing: PricingRow[];
}

interface AdminSessionUser {
  id: string;
  email: string;
  name: string;
  role: string;
  color: string | null;
  avatarUrl: string | null;
}

type Tab = "overview" | "users" | "logs" | "pricing";
const CHART_COLORS = ["#34d399", "#60a5fa", "#f472b6", "#fbbf24", "#a78bfa", "#f87171"];

export function AdminDashboard() {
  const [data, setData] = useState<Data | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  const [currentUser, setCurrentUser] = useState<AdminSessionUser | null>(null);
  const [accountOpen, setAccountOpen] = useState(false);

  const load = async () => {
    const res = await fetch("/api/admin/data", { cache: "no-store" });
    if (res.ok) setData(await res.json());
  };
  const loadCurrentUser = async () => {
    try {
      const response = await fetch("/api/auth/me", { cache: "no-store" });
      if (!response.ok) return;
      const json = await response.json();
      setCurrentUser(json.user ?? null);
    } catch {
      setCurrentUser(null);
    }
  };
  useEffect(() => {
    load();
    loadCurrentUser();
  }, []);

  const usersById = useMemo(() => {
    const m: Record<string, AdminUser> = {};
    for (const u of data?.users ?? []) m[u.id] = u;
    return m;
  }, [data]);

  return (
    <div className="min-h-[100dvh] bg-ink-900 text-white">
      <header className="flex h-14 items-center gap-3 border-b border-line px-3 sm:px-4">
        <a
          href="/"
          className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm text-white/70 hover:bg-white/5 hover:text-white"
        >
          <ArrowLeft className="h-4 w-4" /> Back to app
        </a>
        <span className="text-sm font-semibold">Admin</span>
        {currentUser && (
          <button
            type="button"
            onClick={() => setAccountOpen(true)}
            className="ml-auto flex min-w-0 items-center gap-2 rounded-lg border border-line bg-ink-800 py-1 pl-1 pr-2 text-sm text-white/70 transition hover:border-lineStrong hover:text-white"
            aria-label="Open account settings"
          >
            <span
              className="relative grid h-7 w-7 shrink-0 place-items-center overflow-hidden rounded-full text-xs font-semibold text-ink-900"
              style={{ background: currentUser.color || "#34d399" }}
            >
              {(currentUser.name || currentUser.email).charAt(0).toUpperCase()}
              {currentUser.avatarUrl && (
                <img src={currentUser.avatarUrl} alt="" className="absolute inset-0 h-full w-full object-cover" />
              )}
            </span>
            <span className="hidden max-w-32 truncate sm:inline">{currentUser.name || currentUser.email}</span>
            <Settings className="h-4 w-4 shrink-0" />
          </button>
        )}
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
              aria-label={label}
              aria-pressed={tab === id}
              title={label}
              className={cn(
                "flex flex-1 items-center justify-center gap-1.5 rounded-lg py-2 text-sm font-medium transition",
                tab === id ? "bg-ink-650 text-white" : "text-white/55 hover:text-white"
              )}
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span className="hidden min-[420px]:inline">{label}</span>
            </button>
          ))}
        </div>

        {!data ? (
          <p className="py-20 text-center text-white/40">Loading…</p>
        ) : tab === "overview" ? (
          <Overview data={data} />
        ) : tab === "users" ? (
          <UsersTab data={data} reload={load} currentUserId={currentUser?.id ?? null} />
        ) : tab === "logs" ? (
          <LogsTab data={data} usersById={usersById} />
        ) : (
          <PricingTab data={data} reload={load} />
        )}
      </div>

      {currentUser && (
        <AccountSettings
          open={accountOpen}
          user={currentUser}
          onClose={() => setAccountOpen(false)}
          onUserUpdated={async () => {
            await Promise.all([loadCurrentUser(), load()]);
          }}
        />
      )}
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

      <HiggsfieldTokenCard />
    </div>
  );
}

/** Recovery card: when the Higgsfield OAuth token family dies (generations
 *  fail with "token refresh failed"), run `npm run hf:login` locally and
 *  paste the resulting .higgsfield-mcp-token.json here. */
function HiggsfieldTokenCard() {
  const [value, setValue] = useState("");
  const [state, setState] = useState<"idle" | "saving" | "ok" | "error">("idle");
  const [message, setMessage] = useState("");

  const save = async () => {
    setState("saving");
    try {
      const parsed = JSON.parse(value);
      const res = await fetch("/api/admin/set-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      setState("ok");
      setMessage("Token seeded — Higgsfield generations should work now.");
      setValue("");
    } catch (e: any) {
      setState("error");
      setMessage(e?.message || "Failed.");
    }
  };

  return (
    <Panel title="Higgsfield MCP token">
      <p className="mb-2 text-xs text-white/45">
        If Higgsfield generations fail with “token refresh failed”, run{" "}
        <code className="rounded bg-ink-700 px-1">npm run hf:login</code> on any machine
        and paste the contents of <code className="rounded bg-ink-700 px-1">.higgsfield-mcp-token.json</code>{" "}
        below to re-seed production.
      </p>
      <div className="flex items-start gap-2">
        <textarea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder='{"access_token": "...", "refresh_token": "...", "client_id": "..."}'
          rows={3}
          className="flex-1 rounded-lg border border-line bg-ink-700 px-2.5 py-1.5 font-mono text-xs outline-none focus:border-brand/40"
        />
        <button
          onClick={save}
          disabled={!value.trim() || state === "saving"}
          className="rounded-lg border border-line bg-ink-700 px-3 py-1.5 text-sm text-white/80 hover:text-white disabled:opacity-40"
        >
          {state === "saving" ? "Saving…" : "Seed"}
        </button>
      </div>
      {message && (
        <p className={cn("mt-2 text-xs", state === "error" ? "text-red-400" : "text-brand")}>
          {message}
        </p>
      )}
    </Panel>
  );
}

const TOOLTIP = {
  background: "#15151a",
  border: "1px solid #ffffff1a",
  borderRadius: 8,
  fontSize: 12,
};

type AdminNotice = { kind: "success" | "error"; text: string } | null;
type PendingUserAction = { kind: "status" | "delete"; user: AdminUser } | null;

function UsersTab({
  data,
  reload,
  currentUserId,
}: {
  data: Data;
  reload: () => void;
  currentUserId: string | null;
}) {
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ email: "", password: "", name: "", role: "user" });
  const [creating, setCreating] = useState(false);
  const [createNotice, setCreateNotice] = useState<AdminNotice>(null);
  const [notice, setNotice] = useState<AdminNotice>(null);
  const [resetUser, setResetUser] = useState<AdminUser | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingUserAction>(null);
  const [actionBusy, setActionBusy] = useState(false);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (form.password.length < 8 || form.password.length > 128) {
      setCreateNotice({
        kind: "error",
        text: "Password must be between 8 and 128 characters.",
      });
      return;
    }
    setCreating(true);
    setCreateNotice(null);
    try {
      const response = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const json = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(json.error || "Could not create the user.");
      setForm({ email: "", password: "", name: "", role: "user" });
      setAdding(false);
      setNotice({ kind: "success", text: "User created." });
      reload();
    } catch (error) {
      setCreateNotice({
        kind: "error",
        text: error instanceof Error ? error.message : "Could not create the user.",
      });
    } finally {
      setCreating(false);
    }
  };

  const patchUser = async (
    id: string,
    body: Record<string, unknown>,
    successMessage: string
  ) => {
    setNotice(null);
    try {
      const response = await fetch("/api/admin/users", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, ...body }),
      });
      const json = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(json.error || "Could not update the user.");
      setNotice({ kind: "success", text: successMessage });
      reload();
      return true;
    } catch (error) {
      setNotice({
        kind: "error",
        text: error instanceof Error ? error.message : "Could not update the user.",
      });
      return false;
    }
  };

  const deleteUser = async (user: AdminUser) => {
    setNotice(null);
    try {
      const response = await fetch(`/api/admin/users?id=${encodeURIComponent(user.id)}`, {
        method: "DELETE",
      });
      const json = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(json.error || "Could not delete the user.");
      setNotice({ kind: "success", text: `${user.name || user.email} was deleted.` });
      reload();
      return true;
    } catch (error) {
      setNotice({
        kind: "error",
        text: error instanceof Error ? error.message : "Could not delete the user.",
      });
      return false;
    }
  };

  const confirmAction = async () => {
    if (!pendingAction) return;
    setActionBusy(true);
    const { kind, user } = pendingAction;
    const ok =
      kind === "delete"
        ? await deleteUser(user)
        : await patchUser(
            user.id,
            { isActive: !user.isActive },
            user.isActive ? "Account disabled." : "Account enabled."
          );
    setActionBusy(false);
    if (ok) setPendingAction(null);
  };

  const userRows = data.users.map((user) => ({
    user,
    isSelf: user.id === currentUserId,
  }));

  return (
    <div className="space-y-3">
      <div className="flex min-h-9 flex-wrap items-center justify-between gap-2">
        <AdminNoticeLine notice={notice} />
        <button
          type="button"
          onClick={() => {
            setAdding((value) => !value);
            setCreateNotice(null);
          }}
          aria-expanded={adding}
          aria-controls="new-user-form"
          className="ml-auto flex items-center gap-1.5 rounded-lg bg-white px-3 py-2 text-sm font-semibold text-ink-900 transition hover:bg-white/90"
        >
          {adding ? <X className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
          {adding ? "Cancel" : "New user"}
        </button>
      </div>

      <AnimatePresence initial={false}>
        {adding && (
          <motion.form
            id="new-user-form"
            onSubmit={create}
            initial={{ opacity: 0, height: 0, y: -8 }}
            animate={{ opacity: 1, height: "auto", y: 0 }}
            exit={{ opacity: 0, height: 0, y: -8 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden"
          >
            <div className="grid grid-cols-1 gap-2 rounded-xl border border-line bg-ink-800 p-3 sm:grid-cols-2 lg:grid-cols-[1.25fr_1fr_1fr_0.7fr_auto]">
              <input
                type="email"
                placeholder="Email"
                aria-label="Email"
                value={form.email}
                onChange={(event) => setForm({ ...form, email: event.target.value })}
                className="rounded-lg border border-line bg-ink-700 px-2.5 py-2 text-sm outline-none transition focus:border-white/25"
                required
              />
              <input
                placeholder="Name"
                aria-label="Name"
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                className="rounded-lg border border-line bg-ink-700 px-2.5 py-2 text-sm outline-none transition focus:border-white/25"
              />
              <input
                type="password"
                placeholder="Password"
                aria-label="Password"
                autoComplete="new-password"
                minLength={8}
                maxLength={128}
                value={form.password}
                onChange={(event) => setForm({ ...form, password: event.target.value })}
                className="rounded-lg border border-line bg-ink-700 px-2.5 py-2 text-sm outline-none transition focus:border-white/25"
                required
              />
              <select
                value={form.role}
                aria-label="Role"
                onChange={(event) => setForm({ ...form, role: event.target.value })}
                className="rounded-lg border border-line bg-ink-700 px-2.5 py-2 text-sm outline-none transition focus:border-white/25"
              >
                <option value="user">user</option>
                <option value="admin">admin</option>
              </select>
              <button
                type="submit"
                disabled={creating || !form.email || !form.password}
                className="flex items-center justify-center gap-2 rounded-lg bg-white px-4 py-2 text-sm font-semibold text-ink-900 transition hover:bg-white/90 disabled:opacity-45 sm:col-span-2 lg:col-span-1"
              >
                {creating && <Loader2 className="h-4 w-4 animate-spin" />}
                Create
              </button>
              {createNotice && (
                <div className="sm:col-span-2 lg:col-span-5">
                  <AdminNoticeLine notice={createNotice} />
                </div>
              )}
            </div>
          </motion.form>
        )}
      </AnimatePresence>

      <div className="space-y-2 sm:hidden">
        {userRows.map(({ user, isSelf }) => (
          <div key={user.id} className="rounded-xl border border-line bg-ink-800 p-3">
            <div className="flex min-w-0 items-center gap-3">
              <AdminAvatar user={user} className="h-10 w-10 text-sm" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">
                  {user.name || user.email}
                  {isSelf && <span className="ml-1.5 text-xs font-normal text-white/35">You</span>}
                </p>
                <p className="truncate text-xs text-white/40">{user.email}</p>
              </div>
              <button
                type="button"
                onClick={() => setPendingAction({ kind: "status", user })}
                disabled={isSelf}
                className={cn(
                  "rounded px-2 py-1 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-40",
                  user.isActive
                    ? "bg-emerald-500/15 text-emerald-300"
                    : "bg-white/10 text-white/50"
                )}
                title={isSelf ? "You cannot disable your own account" : undefined}
              >
                {user.isActive ? "Active" : "Disabled"}
              </button>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3">
              <select
                value={user.role}
                disabled={isSelf}
                aria-label={`Role for ${user.name || user.email}`}
                onChange={(event) =>
                  patchUser(user.id, { role: event.target.value }, "Role updated.")
                }
                className="rounded-lg border border-line bg-ink-700 px-2 py-1.5 text-xs disabled:cursor-not-allowed disabled:opacity-45"
                title={isSelf ? "You cannot change your own role" : undefined}
              >
                <option value="user">user</option>
                <option value="admin">admin</option>
              </select>
              <span className="text-xs text-white/45">
                {user.genCount} gens · {formatCost(user.costCents)}
              </span>
              <UserActions
                user={user}
                isSelf={isSelf}
                onReset={() => setResetUser(user)}
                onDelete={() => setPendingAction({ kind: "delete", user })}
                className="ml-auto"
              />
            </div>
          </div>
        ))}
      </div>

      <div className="scroll-thin hidden overflow-x-auto rounded-xl border border-line sm:block">
        <table className="w-full min-w-[760px] text-sm">
          <thead className="bg-ink-800 text-left text-xs uppercase tracking-wide text-white/40">
            <tr>
              <th className="px-3 py-2">User</th>
              <th className="px-3 py-2">Role</th>
              <th className="px-3 py-2">Gens</th>
              <th className="px-3 py-2">Cost</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {userRows.map(({ user, isSelf }) => (
              <tr key={user.id} className="border-t border-line">
                <td className="px-3 py-2">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <AdminAvatar user={user} className="h-8 w-8 text-xs" />
                    <div className="min-w-0">
                      <p className="max-w-[220px] truncate font-medium">
                        {user.name || user.email}
                        {isSelf && <span className="ml-1.5 text-xs font-normal text-white/35">You</span>}
                      </p>
                      <p className="max-w-[220px] truncate text-xs text-white/40">{user.email}</p>
                    </div>
                  </div>
                </td>
                <td className="px-3 py-2">
                  <select
                    value={user.role}
                    disabled={isSelf}
                    aria-label={`Role for ${user.name || user.email}`}
                    onChange={(event) =>
                      patchUser(user.id, { role: event.target.value }, "Role updated.")
                    }
                    className="rounded-lg border border-line bg-ink-700 px-2 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-45"
                    title={isSelf ? "You cannot change your own role" : undefined}
                  >
                    <option value="user">user</option>
                    <option value="admin">admin</option>
                  </select>
                </td>
                <td className="px-3 py-2 tabular-nums">{user.genCount}</td>
                <td className="px-3 py-2 tabular-nums">{formatCost(user.costCents)}</td>
                <td className="px-3 py-2">
                  <button
                    type="button"
                    onClick={() => setPendingAction({ kind: "status", user })}
                    disabled={isSelf}
                    className={cn(
                      "rounded px-2 py-1 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-40",
                      user.isActive
                        ? "bg-emerald-500/15 text-emerald-300"
                        : "bg-white/10 text-white/50"
                    )}
                    title={isSelf ? "You cannot disable your own account" : undefined}
                  >
                    {user.isActive ? "Active" : "Disabled"}
                  </button>
                </td>
                <td className="px-3 py-2">
                  <UserActions
                    user={user}
                    isSelf={isSelf}
                    onReset={() => setResetUser(user)}
                    onDelete={() => setPendingAction({ kind: "delete", user })}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <AnimatePresence>
        {resetUser && (
          <PasswordResetDialog
            key={`password-${resetUser.id}`}
            user={resetUser}
            onClose={() => setResetUser(null)}
            onReset={async (password) => {
              try {
                const response = await fetch("/api/admin/users", {
                  method: "PATCH",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ id: resetUser.id, password }),
                });
                const json = await response.json().catch(() => ({}));
                if (!response.ok) return json.error || "Could not reset the password.";
                setNotice({ kind: "success", text: "Password reset." });
                setResetUser(null);
                reload();
                return null;
              } catch {
                return "Could not reset the password.";
              }
            }}
          />
        )}
        {pendingAction && (
          <ConfirmUserActionDialog
            key={`${pendingAction.kind}-${pendingAction.user.id}`}
            action={pendingAction}
            busy={actionBusy}
            onClose={() => !actionBusy && setPendingAction(null)}
            onConfirm={confirmAction}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

function AdminAvatar({ user, className }: { user: AdminUser; className?: string }) {
  return (
    <span
      className={cn(
        "relative grid shrink-0 place-items-center overflow-hidden rounded-full font-semibold text-ink-900 ring-1 ring-white/10",
        className
      )}
      style={{ background: user.color || "#34d399" }}
    >
      {(user.name || user.email).charAt(0).toUpperCase()}
      {user.avatarUrl && (
        <img src={user.avatarUrl} alt="" className="absolute inset-0 h-full w-full object-cover" />
      )}
    </span>
  );
}

function UserActions({
  user,
  isSelf,
  onReset,
  onDelete,
  className,
}: {
  user: AdminUser;
  isSelf: boolean;
  onReset: () => void;
  onDelete: () => void;
  className?: string;
}) {
  return (
    <div className={cn("flex justify-end gap-1", className)}>
      <button
        type="button"
        onClick={onReset}
        disabled={isSelf}
        aria-label={
          isSelf
            ? "Use Account settings to change your password"
            : `Reset password for ${user.name || user.email}`
        }
        title={isSelf ? "Use Account settings to change your password" : "Reset password"}
        className="grid h-8 w-8 place-items-center rounded-lg text-white/55 transition hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30 disabled:cursor-not-allowed disabled:opacity-30"
      >
        <KeyRound className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={onDelete}
        disabled={isSelf}
        aria-label={`Delete ${user.name || user.email}`}
        title={isSelf ? "You cannot delete your own account" : "Delete user"}
        className="grid h-8 w-8 place-items-center rounded-lg text-white/55 transition hover:bg-red-500/15 hover:text-red-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30 disabled:cursor-not-allowed disabled:opacity-30"
      >
        <Trash2 className="h-4 w-4" />
      </button>
    </div>
  );
}

function PasswordResetDialog({
  user,
  onClose,
  onReset,
}: {
  user: AdminUser;
  onClose: () => void;
  onReset: (password: string) => Promise<string | null>;
}) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<AdminNotice>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (password.length < 8 || password.length > 128) {
      setNotice({ kind: "error", text: "Password must be between 8 and 128 characters." });
      return;
    }
    if (password !== confirm) {
      setNotice({ kind: "error", text: "Passwords do not match." });
      return;
    }
    setBusy(true);
    setNotice(null);
    const error = await onReset(password);
    if (error) setNotice({ kind: "error", text: error });
    setBusy(false);
  };

  return (
    <AdminModal title="Reset password" onClose={() => !busy && onClose()} initialFocusRef={inputRef}>
      <form onSubmit={submit} className="space-y-4">
        <p className="text-sm leading-5 text-white/55">
          Set a new password for <span className="font-medium text-white">{user.name || user.email}</span>.
          Their current password is never shown.
        </p>
        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-white/60">New password</span>
          <input
            ref={inputRef}
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="new-password"
            minLength={8}
            maxLength={128}
            disabled={busy}
            className="w-full rounded-lg border border-line bg-ink-700 px-3 py-2.5 text-sm outline-none transition focus:border-white/25 focus:ring-2 focus:ring-white/10 disabled:opacity-50"
            required
          />
        </label>
        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-white/60">Confirm new password</span>
          <input
            type="password"
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            autoComplete="new-password"
            minLength={8}
            maxLength={128}
            disabled={busy}
            className="w-full rounded-lg border border-line bg-ink-700 px-3 py-2.5 text-sm outline-none transition focus:border-white/25 focus:ring-2 focus:ring-white/10 disabled:opacity-50"
            required
          />
        </label>
        <AdminNoticeLine notice={notice} />
        <div className="flex justify-end gap-2 border-t border-line pt-4">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-lg px-3 py-2 text-sm text-white/60 transition hover:bg-white/[0.06] hover:text-white disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || !password || !confirm}
            className="flex items-center gap-2 rounded-lg bg-white px-3.5 py-2 text-sm font-semibold text-ink-900 transition hover:bg-white/90 disabled:opacity-45"
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            Reset password
          </button>
        </div>
      </form>
    </AdminModal>
  );
}

function ConfirmUserActionDialog({
  action,
  busy,
  onClose,
  onConfirm,
}: {
  action: NonNullable<PendingUserAction>;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  const isDelete = action.kind === "delete";
  const isDisable = action.kind === "status" && action.user.isActive;
  const verb = isDelete ? "Delete" : isDisable ? "Disable" : "Enable";
  const Icon = isDelete ? Trash2 : isDisable ? UserX : UserCheck;

  return (
    <AdminModal title={`${verb} account?`} onClose={onClose} initialFocusRef={confirmRef}>
      <div className="space-y-4">
        <p className="text-sm leading-5 text-white/55">
          {isDelete ? (
            <>This permanently deletes <span className="font-medium text-white">{action.user.name || action.user.email}</span>.</>
          ) : (
            <>
              {isDisable ? "Disabling" : "Enabling"} <span className="font-medium text-white">{action.user.name || action.user.email}</span>{" "}
              {isDisable ? "blocks future sign-ins without deleting their data." : "restores their access."}
            </>
          )}
        </p>
        <div className="flex justify-end gap-2 border-t border-line pt-4">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-lg px-3 py-2 text-sm text-white/60 transition hover:bg-white/[0.06] hover:text-white disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className={cn(
              "flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-semibold transition disabled:opacity-45",
              isDelete || isDisable
                ? "bg-red-500 text-white hover:bg-red-400"
                : "bg-white text-ink-900 hover:bg-white/90"
            )}
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Icon className="h-4 w-4" />}
            {verb}
          </button>
        </div>
      </div>
    </AdminModal>
  );
}

function AdminModal({
  title,
  onClose,
  initialFocusRef,
  children,
}: {
  title: string;
  onClose: () => void;
  initialFocusRef?: RefObject<HTMLElement | null>;
  children: React.ReactNode;
}) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const frame = requestAnimationFrame(() => {
      initialFocusRef?.current?.focus();
      if (!initialFocusRef?.current) {
        dialogRef.current?.querySelector<HTMLElement>("button, input")?.focus();
      }
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
        ) ?? []
      );
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKeyDown);
      previousFocus?.focus();
    };
  }, [initialFocusRef]);

  return (
    <motion.div
      className="fixed inset-0 z-[90] grid place-items-end bg-black/65 p-0 backdrop-blur-sm sm:place-items-center sm:p-4"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18 }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <motion.div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        initial={{ opacity: 0, y: 24, scale: 0.985 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 18, scale: 0.985 }}
        transition={{ type: "spring", stiffness: 400, damping: 36 }}
        className="w-full rounded-t-2xl border border-line bg-ink-800 shadow-pop sm:max-w-md sm:rounded-2xl"
      >
        <div className="flex h-14 items-center justify-between border-b border-line px-4">
          <h2 id={titleId} className="text-sm font-semibold">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="grid h-8 w-8 place-items-center rounded-lg text-white/50 transition hover:bg-white/[0.07] hover:text-white"
            aria-label={`Close ${title.toLowerCase()}`}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="p-4">{children}</div>
      </motion.div>
    </motion.div>
  );
}

function AdminNoticeLine({ notice }: { notice: AdminNotice }) {
  return (
    <span
      role="status"
      aria-live="polite"
      className={cn(
        "flex min-h-5 items-center gap-1.5 text-xs",
        notice?.kind === "error" ? "text-red-300" : "text-emerald-300"
      )}
    >
      {notice?.kind === "success" && <CheckCircle2 className="h-3.5 w-3.5" />}
      {notice?.text}
    </span>
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

      <ActivityLog data={data} usersById={usersById} />
    </div>
  );
}

/** One-line human summary of an audit event's detail payload. */
function activitySummary(a: ActivityRow): string {
  const d = a.detail || {};
  switch (a.action) {
    case "delete":
      return [d.kind, d.model, d.prompt ? `“${String(d.prompt).slice(0, 80)}…”` : null]
        .filter(Boolean)
        .join(" · ");
    case "delete_asset":
      return [d.kind, d.name && `"${d.name}"`, d.slug && `@${d.slug}`]
        .filter(Boolean)
        .join(" · ");
    case "delete_project":
      return `project ${d.projectId ?? ""}`;
    case "delete_folder":
      return `folder ${d.folderId ?? ""} in project ${d.projectId ?? ""}`;
    case "generate":
      return [d.kind, d.model, d.costCents != null ? formatCost(Number(d.costCents)) : null]
        .filter(Boolean)
        .join(" · ");
    default:
      return d && Object.keys(d).length ? JSON.stringify(d).slice(0, 100) : "";
  }
}

function ActivityLog({
  data,
  usersById,
}: {
  data: Data;
  usersById: Record<string, AdminUser>;
}) {
  const [action, setAction] = useState("");
  const actions = useMemo(
    () => Array.from(new Set((data.activity ?? []).map((a) => a.action))),
    [data]
  );
  const rows = useMemo(
    () => (data.activity ?? []).filter((a) => (action ? a.action === action : true)),
    [data, action]
  );
  const sel =
    "rounded-lg border border-line bg-ink-700 px-2.5 py-1.5 text-sm outline-none focus:border-brand/40";
  return (
    <div className="space-y-2 pt-4">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold text-white">Activity</h3>
        <select value={action} onChange={(e) => setAction(e.target.value)} className={sel}>
          <option value="">All actions</option>
          {actions.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        <p className="text-xs text-white/40">{rows.length} events</p>
      </div>
      <div className="overflow-hidden rounded-xl border border-line">
        <table className="w-full text-sm">
          <thead className="bg-ink-800 text-left text-xs uppercase tracking-wide text-white/40">
            <tr>
              <th className="px-3 py-2">Time</th>
              <th className="px-3 py-2">User</th>
              <th className="px-3 py-2">Action</th>
              <th className="px-3 py-2">Detail</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => (
              <tr key={a.id} className="border-t border-line align-top">
                <td className="whitespace-nowrap px-3 py-2 text-xs text-white/55">
                  {new Date(a.createdAt).toLocaleString()}
                </td>
                <td className="px-3 py-2 text-xs">
                  {usersById[a.userId || ""]?.name || usersById[a.userId || ""]?.email || "—"}
                </td>
                <td
                  className={cn(
                    "px-3 py-2 text-xs",
                    a.action.startsWith("delete") && "text-red-400"
                  )}
                >
                  {a.action}
                </td>
                <td className="max-w-[380px] truncate px-3 py-2 text-xs text-white/60">
                  {activitySummary(a)}
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
