"use client";

import { useEffect, useId, useState } from "react";
import { motion } from "framer-motion";
import { AlertTriangle, ArrowRight, BadgeCheck, Loader2, ShieldOff } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { apiErrorMessage } from "@/lib/api-error";
import { cn } from "@/lib/utils";
import { ScopePicker } from "@/components/AgentAccessPanel";
import { centsToDollarsText, dollars, dollarsToCents, redirectLabel, verifiedHost, wholeCents } from "@/lib/agent-access";

const REQUEST_KEYS = ["response_type", "client_id", "redirect_uri", "state", "scope", "code_challenge", "code_challenge_method", "resource"];
const inputClass =
  "w-full rounded-lg border border-line bg-ink-800 px-3 py-2.5 text-sm text-white outline-none transition focus:border-white/30 focus:ring-2 focus:ring-white/10 disabled:opacity-55";

function authorizationRequest() {
  const params = new URLSearchParams(window.location.search);
  return Object.fromEntries(REQUEST_KEYS.filter((key) => params.has(key)).map((key) => [key, params.get(key)]));
}

/** OAuth consent for agent apps; Django validates the request and issues the code. */
export default function AuthorizePage() {
  const [request, setRequest] = useState(null);
  const [details, setDetails] = useState(null);
  const [failure, setFailure] = useState(null);

  useEffect(() => {
    const current = authorizationRequest();
    setRequest(current);
    (async () => {
      try {
        const response = await apiFetch(`/api/oauth/authorize/request?${new URLSearchParams(current)}`);
        const json = await response.json().catch(() => ({}));
        if (response.status === 401) {
          window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
          return;
        }
        if (!response.ok) {
          setFailure({ message: json.error_description || apiErrorMessage(json, response.status, "This sign-in request is not valid."), redirectTo: json.redirectTo });
          return;
        }
        setDetails(json);
      } catch {
        setFailure({ message: "Network error. Reload the page to try again." });
      }
    })();
  }, []);

  return (
    <div className="flex min-h-full items-center justify-center bg-ink-900 p-4 sm:p-6">
      <motion.main
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ type: "spring", stiffness: 240, damping: 26 }}
        className="w-full max-w-md rounded-2xl border border-line bg-ink-850 p-6 shadow-pop sm:p-7"
        aria-busy={!details && !failure}
      >
        <div className="mb-5 flex items-center gap-2.5">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.png" alt="Veevee.ai" className="h-8 w-8 rounded-lg shadow-sm" />
          <p className="text-sm font-semibold text-white">Veevee.ai</p>
        </div>
        {failure ? (
          <Failure failure={failure} />
        ) : details ? (
          <Consent request={request} details={details} />
        ) : (
          <div className="flex min-h-40 items-center justify-center" role="status">
            <Loader2 className="h-5 w-5 animate-spin text-white/45" aria-label="Checking the sign-in request" />
          </div>
        )}
      </motion.main>
    </div>
  );
}

function Failure({ failure }) {
  return (
    <div className="space-y-4" role="alert">
      <div className="flex gap-3">
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-300" />
        <div>
          <h1 className="text-base font-semibold text-white">This app can&apos;t connect</h1>
          <p className="mt-1 text-sm leading-6 text-white/55">{failure.message}</p>
        </div>
      </div>
      {failure.redirectTo && (
        <a href={failure.redirectTo}
          className="flex h-10 items-center justify-center gap-2 rounded-lg border border-lineStrong text-sm text-white/80 transition hover:border-white/25 hover:text-white">
          Return to the app <ArrowRight className="h-4 w-4" />
        </a>
      )}
    </div>
  );
}

function AppMark({ client }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className="grid h-12 w-12 shrink-0 place-items-center overflow-hidden rounded-xl border border-lineStrong bg-ink-700 text-lg font-semibold text-white">
      {client.logoUri && !failed ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={client.logoUri} alt="" className="h-full w-full object-cover" onError={() => setFailed(true)} referrerPolicy="no-referrer" />
      ) : (
        client.name.charAt(0).toUpperCase()
      )}
    </span>
  );
}

function Consent({ request, details }) {
  const { client } = details;
  const ids = { cap: useId(), auto: useId() };
  const [scopes, setScopes] = useState(details.requestedScopes);
  const [cap, setCap] = useState(centsToDollarsText(details.defaults.dailyCapCents));
  const [auto, setAuto] = useState(String(details.defaults.autoApproveCents));
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const verified = verifiedHost(client);

  // A correction clears the previous complaint.
  useEffect(() => setError(null), [scopes, cap, auto]);
  const spends = scopes.includes("veevee.generate");

  const decide = async (approve) => {
    const dailyCapCents = spends ? dollarsToCents(cap) : details.defaults.dailyCapCents;
    const autoApproveCents = spends ? wholeCents(auto, details.autoApproveMaxCents) : 0;
    if (approve) {
      if (!scopes.length) return setError("Choose at least one permission.");
      if (dailyCapCents == null || dailyCapCents > details.userDailyCapCents) {
        return setError(`Choose a daily limit up to ${dollars(details.userDailyCapCents)}.`);
      }
      if (autoApproveCents == null) return setError(`Auto-approve must be 0 to ${details.autoApproveMaxCents} cents.`);
    }
    setBusy(approve ? "allow" : "deny");
    setError(null);
    try {
      const response = await apiFetch("/api/oauth/authorize/decision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ request, approve, scopes, dailyCapCents, autoApproveCents }),
      });
      const json = await response.json().catch(() => ({}));
      if (!json.redirectTo) throw new Error(json.error_description || apiErrorMessage(json, response.status, "Could not complete the sign-in."));
      window.location.assign(json.redirectTo);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not complete the sign-in.");
      setBusy(null);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3.5">
        <AppMark client={client} />
        <div className="min-w-0">
          <h1 className="text-base font-semibold leading-6 text-white">
            <span className="break-words">{client.name}</span> wants to use your Veevee account
          </h1>
          <p className="mt-0.5 text-xs text-white/45">
            Signed in as{" "}
            <span className="inline-block max-w-full truncate align-bottom" title={details.user.email}>{details.user.email}</span>
          </p>
        </div>
      </div>

      <dl className="space-y-2 rounded-xl border border-line bg-ink-800/70 p-3 text-xs">
        <div className="flex items-baseline justify-between gap-3">
          <dt className="shrink-0 text-white/45">Returns you to</dt>
          <dd className="min-w-0 truncate font-mono text-white/85" title={client.redirectUri}>{redirectLabel(client)}</dd>
        </div>
        {verified && (
          <div className="flex items-baseline justify-between gap-3">
            <dt className="shrink-0 text-white/45">Published by</dt>
            <dd className="flex min-w-0 items-center gap-1 truncate text-emerald-200">
              <BadgeCheck className="h-3.5 w-3.5 shrink-0" /> {verified}
            </dd>
          </div>
        )}
      </dl>

      {details.enabled ? (
        <>
          <ScopePicker scopes={details.scopes} selected={scopes} onChange={setScopes} disabled={Boolean(busy)} />
          {spends && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <label className="block space-y-1.5" htmlFor={ids.cap}>
                  <span className="text-xs font-medium text-white/60">Daily limit for this app</span>
                  <div className="relative">
                    <span aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-white/40">$</span>
                    <input id={ids.cap} inputMode="decimal" value={cap} onChange={(event) => setCap(event.target.value)}
                      className={cn(inputClass, "pl-6 tabular-nums")} disabled={Boolean(busy)} />
                  </div>
                </label>
                <label className="block space-y-1.5" htmlFor={ids.auto}>
                  <span className="text-xs font-medium text-white/60">Auto-approve up to</span>
                  <div className="relative">
                    <input id={ids.auto} inputMode="numeric" value={auto} onChange={(event) => setAuto(event.target.value)}
                      className={cn(inputClass, "pr-8 tabular-nums")} disabled={Boolean(busy)} />
                    <span aria-hidden="true" className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-white/40">¢</span>
                  </div>
                </label>
              </div>
              <p className="text-xs leading-5 text-white/40">
                Jobs at or below the auto-approve amount start right away. Pricier jobs show the price first, and jobs of{" "}
                {dollars(details.confirmAtCents)} or more need your OK. Your account limit is {dollars(details.userDailyCapCents)} a day.
              </p>
            </div>
          )}
        </>
      ) : (
        <div className="flex gap-3 rounded-xl border border-amber-400/20 bg-amber-400/[0.06] p-3.5">
          <ShieldOff className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
          <p className="text-sm leading-5 text-white/65">Agent access is off for your account. Ask a Veevee admin to turn it on.</p>
        </div>
      )}

      <div className="space-y-3 border-t border-line pt-4">
        {error && <p role="alert" className="text-xs text-red-300">{error}</p>}
        <div className="flex gap-2">
          <button type="button" onClick={() => decide(false)} disabled={Boolean(busy)}
            className="flex h-10 flex-1 items-center justify-center gap-2 rounded-lg border border-lineStrong text-sm text-white/75 transition hover:border-white/25 hover:text-white disabled:opacity-45">
            {busy === "deny" && <Loader2 className="h-4 w-4 animate-spin" />}
            {details.enabled ? "Deny" : "Cancel"}
          </button>
          {details.enabled && (
            <button type="button" onClick={() => decide(true)} disabled={Boolean(busy)}
              className="flex h-10 flex-1 items-center justify-center gap-2 rounded-lg bg-white text-sm font-semibold text-ink-900 transition hover:bg-white/90 disabled:opacity-45">
              {busy === "allow" && <Loader2 className="h-4 w-4 animate-spin" />}
              Allow
            </button>
          )}
        </div>
        <p className="text-center text-[11px] leading-4 text-white/35">
          You can disconnect this app any time in Account settings, Agent access.
        </p>
      </div>
    </div>
  );
}
