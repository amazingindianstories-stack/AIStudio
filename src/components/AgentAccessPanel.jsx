"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Bot, Check, Copy, KeyRound, Loader2, Plug, Plus, ShieldOff, X } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { apiErrorMessage } from "@/lib/api-error";
import { copyText } from "@/lib/copy-text";
import { cn } from "@/lib/utils";
import {
  EXPIRY_CHOICES,
  centsToDollarsText,
  claudeCodeCommand,
  dollars,
  dollarsToCents,
  relativeTime,
  scopeTitle,
  shortDate,
  wholeCents,
} from "@/lib/agent-access";

const inputClass =
  "w-full rounded-lg border border-line bg-ink-700 px-3 py-2.5 text-sm text-white outline-none transition placeholder:text-white/25 focus:border-white/25 focus:ring-2 focus:ring-white/10 disabled:cursor-not-allowed disabled:opacity-55";

/** Settings: personal access tokens and connected agent apps (Django /api/mcp/*). */
export function AgentAccessPanel() {
  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [creating, setCreating] = useState(false);
  const [revealed, setRevealed] = useState(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const response = await apiFetch("/api/mcp/tokens");
      const json = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(apiErrorMessage(json, response.status, "Could not load agent access."));
      setData(json);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Could not load agent access.");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (!data) {
    return (
      <div className="flex min-h-40 items-center justify-center text-sm text-white/45" role="status">
        {loadError ? (
          <span className="flex flex-col items-center gap-3">
            {loadError}
            <button type="button" onClick={load} className="rounded-lg border border-lineStrong px-3 py-1.5 text-xs text-white/75 hover:text-white">
              Try again
            </button>
          </span>
        ) : (
          <Loader2 className="h-5 w-5 animate-spin" aria-label="Loading agent access" />
        )}
      </div>
    );
  }

  const { access } = data;
  return (
    <div className="space-y-5">
      {!access.enabled && (
        <div className="flex gap-3 rounded-xl border border-amber-400/20 bg-amber-400/[0.06] p-3.5">
          <ShieldOff className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
          <div className="min-w-0 text-sm">
            <p className="font-medium text-amber-100">Agent access is off for your account</p>
            <p className="mt-0.5 text-xs leading-5 text-white/55">
              An admin can turn it on. Then you can connect Claude, ChatGPT, Cursor and other AI agents to Veevee.
            </p>
          </div>
        </div>
      )}

      <ServerAddress resource={access.resource} />

      <SpendSummary access={access} />

      <section aria-labelledby="agent-tokens-heading" className="space-y-2.5">
        <div className="flex min-h-9 items-center justify-between gap-3">
          <div className="min-w-0">
            <h3 id="agent-tokens-heading" className="text-sm font-semibold text-white">Personal access tokens</h3>
            <p className="text-xs text-white/40">For Claude Code, Cursor and other tools that take a token.</p>
          </div>
          {access.enabled && !creating && !revealed && (
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-white px-3 text-xs font-semibold text-ink-900 transition hover:bg-white/90"
            >
              <Plus className="h-3.5 w-3.5" />
              New token
            </button>
          )}
        </div>

        <AnimatePresence initial={false} mode="wait">
          {creating && (
            <CreateTokenForm
              key="create"
              access={access}
              onCancel={() => setCreating(false)}
              onCreated={(json) => {
                setCreating(false);
                setRevealed(json.token);
                setData(json);
              }}
            />
          )}
          {revealed && (
            <RevealedToken key="reveal" token={revealed} resource={access.resource} onDone={() => setRevealed(null)} />
          )}
        </AnimatePresence>

        {data.tokens.length ? (
          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line">
            {data.tokens.map((token) => (
              <GrantRow
                key={token.id}
                icon={KeyRound}
                title={token.name}
                code={token.hint}
                grant={token}
                details={`Created ${shortDate(token.createdAt)} · Expires ${shortDate(token.expiresAt)}`}
                revokePath={`/api/mcp/tokens/${token.id}`}
                onRevoked={setData}
              />
            ))}
          </ul>
        ) : (
          !creating && !revealed && <EmptyLine>No tokens yet.</EmptyLine>
        )}
      </section>

      <section aria-labelledby="agent-apps-heading" className="space-y-2.5">
        <div>
          <h3 id="agent-apps-heading" className="text-sm font-semibold text-white">Connected apps</h3>
          <p className="text-xs text-white/40">Apps you approved by signing in, such as Claude or ChatGPT.</p>
        </div>
        {data.connections.length ? (
          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line">
            {data.connections.map((app) => (
              <GrantRow
                key={app.id}
                icon={Plug}
                logoUri={app.logoUri}
                title={app.clientName}
                grant={app}
                details={`Connected ${shortDate(app.connectedAt)}`}
                revokePath={`/api/mcp/connections/${app.id}`}
                onRevoked={setData}
              />
            ))}
          </ul>
        ) : (
          <EmptyLine>No connected apps.</EmptyLine>
        )}
      </section>
    </div>
  );
}

function EmptyLine({ children }) {
  return <p className="rounded-xl border border-dashed border-line px-3 py-3 text-center text-xs text-white/35">{children}</p>;
}

function CopyField({ label, value, mono = true, wrap = false }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    if (await copyText(value)) {
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1600);
    }
  };
  return (
    <div className="flex min-w-0 items-start gap-2 rounded-lg border border-line bg-ink-900/60 py-1.5 pl-3 pr-1.5">
      <code
        className={cn(
          "min-w-0 flex-1 py-1 text-xs text-white/85",
          mono && "font-mono",
          wrap ? "break-all" : "truncate"
        )}
        title={wrap ? undefined : value}
      >
        {value}
      </code>
      <button
        type="button"
        onClick={copy}
        aria-label={`Copy ${label}`}
        className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-white/55 transition hover:bg-white/[0.08] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30"
      >
        {copied ? <Check className="h-3.5 w-3.5 text-emerald-300" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
    </div>
  );
}

function ServerAddress({ resource }) {
  return (
    <section className="space-y-2 rounded-xl border border-line bg-ink-750/60 p-3.5" aria-labelledby="agent-server-heading">
      <div className="flex items-center gap-2">
        <Bot className="h-4 w-4 text-white/60" />
        <h3 id="agent-server-heading" className="text-sm font-semibold text-white">Connect an AI agent</h3>
      </div>
      <p className="text-xs leading-5 text-white/50">
        Add this server address to your agent. Apps with sign-in ask you to approve them here; tools without it use a token.
      </p>
      <CopyField label="server address" value={resource} />
    </section>
  );
}

function SpendSummary({ access }) {
  const used = Math.min(1, access.userDailyCapCents ? access.spentTodayCents / access.userDailyCapCents : 0);
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className="text-white/55">Agent spend, last 24 hours</span>
        <span className="tabular-nums text-white/80">
          {dollars(access.spentTodayCents)} <span className="text-white/35">of {dollars(access.userDailyCapCents)}</span>
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.07]" aria-hidden="true">
        <div className="h-full rounded-full bg-white/70" style={{ width: `${used * 100}%` }} />
      </div>
    </div>
  );
}

function CreateTokenForm({ access, onCancel, onCreated }) {
  const nameRef = useRef(null);
  const ids = { name: useId(), cap: useId(), auto: useId(), expiry: useId() };
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState(["veevee.read", "veevee.generate"]);
  const [cap, setCap] = useState(centsToDollarsText(access.defaults.dailyCapCents));
  const [auto, setAuto] = useState(String(access.defaults.autoApproveCents));
  const [expiry, setExpiry] = useState(access.defaults.expiresInDays);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    const frame = requestAnimationFrame(() => nameRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);

  // A correction clears the previous complaint.
  useEffect(() => setError(null), [name, scopes, cap, auto, expiry]);

  const submit = async (event) => {
    event.preventDefault();
    const dailyCapCents = dollarsToCents(cap);
    const autoApproveCents = wholeCents(auto, access.autoApproveMaxCents);
    if (!name.trim()) return setError("Give the token a name.");
    if (!scopes.length) return setError("Choose at least one permission.");
    if (dailyCapCents == null || dailyCapCents > access.userDailyCapCents) {
      return setError(`Choose a daily limit up to ${dollars(access.userDailyCapCents)}.`);
    }
    if (autoApproveCents == null) return setError(`Auto-approve must be 0 to ${access.autoApproveMaxCents} cents.`);
    setBusy(true);
    setError(null);
    try {
      const response = await apiFetch("/api/mcp/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), scopes, dailyCapCents, autoApproveCents, expiresInDays: expiry }),
      });
      const json = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(apiErrorMessage(json, response.status, "Could not create the token."));
      onCreated(json);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not create the token.");
      setBusy(false);
    }
  };

  return (
    <motion.form
      onSubmit={submit}
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: "auto" }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
      className="overflow-hidden"
      aria-label="New personal access token"
    >
      <div className="space-y-4 rounded-xl border border-lineStrong bg-ink-750/60 p-3.5">
        <label className="block space-y-1.5" htmlFor={ids.name}>
          <span className="text-xs font-medium text-white/60">Name</span>
          <input
            id={ids.name}
            ref={nameRef}
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={60}
            placeholder="e.g. Claude Code on my laptop"
            className={inputClass}
            disabled={busy}
          />
        </label>
        <ScopePicker scopes={access.scopes} selected={scopes} onChange={setScopes} disabled={busy} />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <label className="block space-y-1.5" htmlFor={ids.cap}>
            <span className="text-xs font-medium text-white/60">Daily limit</span>
            <div className="relative">
              <span aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-white/40">$</span>
              <input id={ids.cap} inputMode="decimal" value={cap} onChange={(event) => setCap(event.target.value)}
                className={cn(inputClass, "pl-6 tabular-nums")} disabled={busy} />
            </div>
          </label>
          <label className="block space-y-1.5" htmlFor={ids.auto}>
            <span className="text-xs font-medium text-white/60">Auto-approve up to</span>
            <div className="relative">
              <input id={ids.auto} inputMode="numeric" value={auto} onChange={(event) => setAuto(event.target.value)}
                className={cn(inputClass, "pr-8 tabular-nums")} disabled={busy} />
              <span aria-hidden="true" className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-white/40">¢</span>
            </div>
          </label>
          <label className="block space-y-1.5" htmlFor={ids.expiry}>
            <span className="text-xs font-medium text-white/60">Expires after</span>
            <select id={ids.expiry} value={expiry} onChange={(event) => setExpiry(Number(event.target.value))}
              className={inputClass} disabled={busy}>
              {EXPIRY_CHOICES.filter((days) => days <= access.maxExpiresInDays).map((days) => (
                <option key={days} value={days}>{days} days</option>
              ))}
            </select>
          </label>
        </div>
        <p className="text-xs leading-5 text-white/40">
          Jobs at or below the auto-approve amount start right away. Pricier jobs show the price first, and
          jobs of {dollars(access.confirmAtCents)} or more need your OK. Your account limit is {dollars(access.userDailyCapCents)} a day.
        </p>
        <div className="flex min-h-9 flex-wrap items-center justify-between gap-3 border-t border-line pt-3.5">
          <span role="status" aria-live="polite" className="min-h-5 text-xs text-red-300">{error}</span>
          <div className="ml-auto flex gap-2">
            <button type="button" onClick={onCancel} disabled={busy}
              className="h-9 rounded-lg px-3 text-sm text-white/60 transition hover:bg-white/[0.06] hover:text-white disabled:opacity-40">
              Cancel
            </button>
            <button type="submit" disabled={busy}
              className="flex h-9 items-center gap-2 rounded-lg bg-white px-3.5 text-sm font-semibold text-ink-900 transition hover:bg-white/90 disabled:opacity-45">
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              Create token
            </button>
          </div>
        </div>
      </div>
    </motion.form>
  );
}

export function ScopePicker({ scopes, selected, onChange, disabled }) {
  return (
    <fieldset className="space-y-1.5" disabled={disabled}>
      <legend className="mb-1.5 text-xs font-medium text-white/60">Permissions</legend>
      {scopes.map((scope) => {
        const checked = selected.includes(scope.id);
        return (
          <label
            key={scope.id}
            className={cn(
              "flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 transition",
              checked ? "border-white/20 bg-white/[0.05]" : "border-line hover:border-white/15"
            )}
          >
            <input
              type="checkbox"
              checked={checked}
              onChange={() => onChange(checked ? selected.filter((id) => id !== scope.id) : [...selected, scope.id])}
              className="mt-0.5 h-4 w-4 shrink-0 accent-white"
            />
            <span className="min-w-0">
              <span className="block text-sm text-white">{scopeTitle(scope.id)}</span>
              <span className="block text-xs leading-5 text-white/45">{scope.description}</span>
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}

function RevealedToken({ token, resource, onDone }) {
  return (
    <motion.div
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: "auto" }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
      className="overflow-hidden"
    >
      <div className="space-y-3 rounded-xl border border-emerald-400/25 bg-emerald-400/[0.05] p-3.5" role="status">
        <div>
          <p className="text-sm font-semibold text-emerald-100">Copy your token now</p>
          <p className="text-xs leading-5 text-white/55">It is shown only once. Store it like a password.</p>
        </div>
        <CopyField label="token" value={token} wrap />
        <div className="space-y-1.5">
          <p className="text-xs text-white/50">Claude Code</p>
          <CopyField label="Claude Code command" value={claudeCodeCommand(resource, token)} wrap />
        </div>
        <div className="flex justify-end">
          <button type="button" onClick={onDone}
            className="h-8 rounded-lg border border-lineStrong px-3 text-xs font-medium text-white/80 transition hover:border-white/25 hover:text-white">
            I saved it
          </button>
        </div>
      </div>
    </motion.div>
  );
}

function GrantRow({ icon: Icon, logoUri, title, code, grant, details, revokePath, onRevoked }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [logoFailed, setLogoFailed] = useState(false);

  const revoke = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await apiFetch(revokePath, { method: "DELETE" });
      const json = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(apiErrorMessage(json, response.status, "Could not revoke access."));
      onRevoked(json);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not revoke access.");
      setBusy(false);
      setConfirming(false);
    }
  };

  return (
    <li className="flex flex-col gap-3 bg-ink-800/40 px-3.5 py-3 sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-lg border border-line bg-ink-700">
          {logoUri && !logoFailed ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={logoUri} alt="" className="h-full w-full object-cover" onError={() => setLogoFailed(true)} referrerPolicy="no-referrer" />
          ) : (
            <Icon className="h-4 w-4 text-white/55" />
          )}
        </span>
        <div className="min-w-0 space-y-1">
          <p className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-sm">
            <span className="truncate font-medium text-white">{title}</span>
            {code && <code className="font-mono text-[11px] text-white/40">{code}</code>}
          </p>
          <div className="flex flex-wrap gap-1">
            {grant.scopes.map((scope) => (
              <span key={scope} className="rounded bg-white/[0.07] px-1.5 py-0.5 text-[11px] text-white/65">{scopeTitle(scope)}</span>
            ))}
          </div>
          <p className="text-[11px] leading-4 text-white/40">
            {dollars(grant.spentTodayCents)} of {dollars(grant.dailyCapCents)} today · auto-approve {grant.autoApproveCents}¢
          </p>
          <p className="text-[11px] leading-4 text-white/35">{details} · {relativeTime(grant.lastUsedAt)}</p>
          {error && <p className="text-xs text-red-300">{error}</p>}
        </div>
      </div>
      <div className="flex shrink-0 justify-end gap-1.5">
        {confirming ? (
          <>
            <button type="button" onClick={() => setConfirming(false)} disabled={busy} aria-label={`Keep ${title}`}
              className="grid h-8 w-8 place-items-center rounded-lg text-white/55 transition hover:bg-white/[0.07] hover:text-white disabled:opacity-40">
              <X className="h-4 w-4" />
            </button>
            <button type="button" onClick={revoke} disabled={busy}
              className="flex h-8 items-center gap-1.5 rounded-lg bg-red-500/90 px-3 text-xs font-semibold text-white transition hover:bg-red-500 disabled:opacity-60">
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Revoke now
            </button>
          </>
        ) : (
          <button type="button" onClick={() => setConfirming(true)} aria-label={`Revoke ${title}`}
            className="h-8 rounded-lg border border-line px-3 text-xs font-medium text-white/70 transition hover:border-red-400/40 hover:bg-red-500/10 hover:text-red-200">
            Revoke
          </button>
        )}
      </div>
    </li>
  );
}
