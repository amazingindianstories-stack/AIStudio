# Design: Admin API Status Page

Contract for implementers and the test-engineer. Files outside the File Plan must
not be touched. Signatures below are the module boundaries — match them exactly.

## Open questions

None blocking. Two judgment calls that the spec left to the architect (Omni check
depth; Gemini metadata-call vs config-presence) are decided inline and justified in
**Trade-offs**. Both are reversible without changing the response contract.

---

## 1. Summary

Add a **Status** tab to the existing admin dashboard that fires a single GET to a new
`/api/admin/status` route. That route (admin-gated by the same `adminOrNull()` pattern
as `/api/admin/data`) runs six independent dependency health checks in parallel, each
wrapped in a 5-second timeout, and returns a flat JSON array of per-check results. All
check logic lives in one new pure-ish module `src/lib/status-checks.ts`; the route is a
thin gate-and-serialize handler; the tab is an inline `StatusTab` component that
self-fetches on mount and on a Refresh click.

Why this beats the main alternative (checking dependencies client-side, or embedding the
health data into the existing `/api/admin/data` blob): the Higgsfield token constraint
and the DB/S3/provider credentials are server-only, so checks **must** run server-side;
and folding health checks into `/api/admin/data` would make every dashboard load pay the
(up to) 5s check cost and couple an on-demand diagnostic to the always-loaded data blob.
A dedicated route keeps the Status tab independent, refreshable in place, and cheap for
the other tabs.

---

## 2. File plan

Exhaustive. Do not modify anything not listed here.

### Create

- **`src/lib/status-checks.ts`** — the core module. Exports the result types, the six
  check functions, the timeout/measure wrapper `runCheck`, the check registry `CHECKS`,
  and the aggregator `runAllChecks`. Owns its own `S3Client` instance (mirrors the
  self-contained client already in `higgsfield-mcp.ts`) so it never has to touch
  `storage.ts`. Imports `db` + `sql` for the Postgres check, `HeadBucketCommand` +
  `S3Client` for S3, and `loadToken` + `isFresh` (newly exported) from the Higgsfield
  provider. `runtime`-agnostic library code (the route pins nodejs).

- **`src/app/api/admin/status/route.ts`** — GET handler. `export const runtime =
  "nodejs";`. Copies the gate shape from `src/app/api/admin/data/route.ts` verbatim
  (`adminOrNull()` → 403 `{ error: "FORBIDDEN" }`), then `return
  NextResponse.json(await runAllChecks())`. No request body, no query params.

### Modify

- **`src/lib/providers/higgsfield-mcp.ts`** — **minimal, mandated export change only.**
  Add the `export` keyword to the two existing declarations:
  - line 87 `async function loadToken()` → `export async function loadToken()`
  - line 124 `function isFresh(...)` → `export function isFresh(...)`
  No other change to this file. Do **not** export, call, or wrap `accessToken()`,
  `refreshToken()`, `refreshOnce()`, or `callTool()`. Both exported functions are
  already read-only (loadToken reads S3→env→local file and populates the module cache;
  isFresh is pure). This is the ONLY provider file that changes.

- **`src/components/AdminDashboard.tsx`** — four localized edits:
  1. Extend the tab union (line 91): `type Tab = "overview" | "users" | "logs" |
     "pricing" | "status";`.
  2. Add an icon import from `lucide-react` (e.g. `Activity`) to the existing import
     block (lines 19–35).
  3. Add `["status", "Status", Activity]` to the tab-bar array (lines 160–166).
  4. In the render dispatch (lines 185–195), render the Status branch **before** the
     `!data` loading gate so the tab does not block on the `/api/admin/data` fetch:
     `{tab === "status" ? <StatusTab /> : !data ? <Loading/> : tab === "overview" ? ...}`.
  5. Add a new inline `function StatusTab()` at the bottom of the file, next to
     `PricingTab` (which ends at line 1379). Inline placement matches the existing
     convention — `UsersTab` (399), `LogsTab` (1097), `PricingTab` (1333) are all inline
     functions in this same file, not separate files. `StatusTab` takes no props (it
     needs neither `data` nor `reload`) and declares its own local `StatusCheck` /
     `StatusResponse` interfaces, matching the file's existing convention of locally
     re-declaring row shapes (`LogRow`, `PricingRow`). Do **not** `import` the types from
     `status-checks.ts` at runtime — that module pulls in `db`/`aws-sdk` and must never
     be bundled into a `"use client"` component.

No new dependencies. `@aws-sdk/client-s3` (`HeadBucketCommand`), `drizzle-orm` (`sql`),
and `lucide-react` are all already in use.

---

## 3. Data model / types

Defined in `src/lib/status-checks.ts` and mirrored (structurally) as local interfaces in
`AdminDashboard.tsx`.

```ts
export type CheckStatus = "ok" | "error" | "unknown";

/** One dependency's health result. */
export interface CheckResult {
  id: string;        // stable machine key, e.g. "gemini" | "higgsfield" | "postgres"
  name: string;      // display label, e.g. "Gemini / Nano Banana Pro"
  status: CheckStatus;
  detail: string;    // short human string: HTTP code, latency note, or error message
  latencyMs: number; // wall-clock time this check took (>= 0)
  checkedAt: number; // Date.now() ms when this check finished
}

/** The whole-batch response. `checks` is always length 6, in registry order. */
export interface StatusResponse {
  checkedAt: number;      // Date.now() ms when the batch started
  checks: CheckResult[];
}
```

Semantics of `status`:
- `ok` — the dependency responded healthily, OR (for config-presence-only checks) the
  required config is present. `detail` says which.
- `error` — a check actually ran and failed: non-2xx HTTP, thrown DB/S3 error, or a
  timeout.
- `unknown` — the check could not be meaningfully attempted because required
  configuration is absent (env var missing, no Higgsfield token found, no cached fresh
  access token). Distinct from `error`: nothing failed, there was just nothing to test.

The route returns `StatusResponse` as a bare object (no envelope), matching
`data/route.ts`. Non-admin returns `{ error: "FORBIDDEN" }` with HTTP 403.

---

## 4. Interfaces (module boundary)

`src/lib/status-checks.ts` public surface:

```ts
export type CheckStatus = "ok" | "error" | "unknown";
export interface CheckResult { /* as above */ }
export interface StatusResponse { /* as above */ }

/** What an individual check returns; the wrapper adds id/name/latency/checkedAt. */
type CheckOutcome = { status: CheckStatus; detail: string };

/** A check receives an AbortSignal (wired to the timeout) and must not throw for
 *  config-absence cases — it returns { status: "unknown", ... } instead. It MAY throw
 *  on genuine failures; runCheck catches those into an "error" result. */
type CheckFn = (signal: AbortSignal) => Promise<CheckOutcome>;

interface CheckDef { id: string; name: string; fn: CheckFn; }

/** The six checks, in the fixed display order. Exported for test injection. */
export const CHECKS: CheckDef[];

/** Wrap one check: measure latency, enforce the timeout, never reject. */
export async function runCheck(def: CheckDef, timeoutMs?: number): Promise<CheckResult>;

/** Run every check in `checks` in parallel and assemble the response.
 *  `checks` defaults to CHECKS; the parameter exists purely as a test seam. */
export async function runAllChecks(
  checks?: CheckDef[],
  timeoutMs?: number
): Promise<StatusResponse>;
```

Route:

```
GET /api/admin/status
  Auth: admin session cookie (adminOrNull). Non-admin → 403 { error: "FORBIDDEN" }.
  200 → StatusResponse  (Content-Type application/json)
```

Constant: `const CHECK_TIMEOUT_MS = 5000;` (spec A4), the default for both
`runCheck` and `runAllChecks`.

The six `CheckDef`s (fixed `id` / `name`, in this order):

| id           | name                        |
|--------------|-----------------------------|
| `gemini`     | Gemini / Nano Banana Pro    |
| `higgsfield` | Higgsfield MCP              |
| `seedance`   | BytePlus ModelArk / Seedance|
| `omni`       | Gemini Omni Flash           |
| `postgres`   | Postgres                    |
| `s3`         | S3 Media Storage            |

---

## 5. The timeout / measure wrapper

Recon confirmed there is **no** `AbortController`/`Promise.race` precedent in `src`.
Introduce one small self-contained helper — not a shared abstraction — used by all six
checks (so it is genuinely reused, satisfying the "≥3 uses" bar in recon §4).

`runCheck` behavior:
1. Record `start = Date.now()`.
2. Create an `AbortController`. Start one `setTimeout(timeoutMs)` that (a) calls
   `controller.abort()` and (b) rejects a private `timeout` promise with a
   `TimeoutError`.
3. `Promise.race([def.fn(controller.signal), timeout])`.
4. On resolve → `{ ...outcome, id, name, latencyMs: Date.now()-start, checkedAt:
   Date.now() }`.
5. On reject → `{ id, name, status: "error", detail, latencyMs, checkedAt }` where
   `detail` is `"Timed out after 5000ms"` for a `TimeoutError`, else `err.message ??
   String(err)`.
6. `finally` clears the timer.

`runCheck` **never rejects.** The single `AbortController` both cancels fetch-based
checks (Gemini) at the socket and is passed to checks that can honor it; `Promise.race`
covers checks that can't observe the signal (Postgres query, S3 SDK, `loadToken`) by
abandoning the pending promise after the deadline. This dual mechanism is deliberate:
AbortController alone cannot bound a hung DB query, and Promise.race alone leaks the
fetch socket.

`runAllChecks`:
```ts
const checkedAt = Date.now();
const settled = await Promise.allSettled(list.map((d) => runCheck(d, timeoutMs)));
const checks = settled.map((s, i) =>
  s.status === "fulfilled" ? s.value
    : { id: list[i].id, name: list[i].name, status: "error",
        detail: "internal check error", latencyMs: 0, checkedAt: Date.now() }
);
return { checkedAt, checks };
```
`Promise.allSettled` (spec AC5/AC9) guarantees one throwing check can never reject the
whole batch. Because `runCheck` already never rejects, the rejected branch is
defense-in-depth, but it keeps the response shape total.

---

## 6. Per-check implementation notes

Constants that live in provider files but are not exported (Gemini API root/model) are
duplicated locally in `status-checks.ts` with a `// mirrors gemini.ts` comment, rather
than adding exports — only Higgsfield gets an export change (see File Plan / Trade-offs).

### 6.1 `gemini` — Gemini / Nano Banana Pro  (LIVE metadata call)
- Healthy predicate: `GET https://generativelanguage.googleapis.com/v1beta/models/
  gemini-3-pro-image` with header `x-goog-api-key: <GOOGLE_API_KEY>` and the passed
  `signal`, returns HTTP 2xx. This is the models *metadata* resource — non-billable, no
  `generateContent` (spec AC8).
- `unknown`: `GOOGLE_API_KEY` not set → `{ status: "unknown", detail: "GOOGLE_API_KEY
  not set" }` (no call made).
- `ok`: 2xx → `{ status: "ok", detail: "HTTP 200" }`.
- `error`: non-2xx → `{ status: "error", detail: "HTTP <code>" }`; network/abort throw
  propagates to `runCheck` → error.
- Timeout: the shared `signal` on `fetch`.

### 6.2 `higgsfield` — Higgsfield MCP  (READ-ONLY, D0 constraint)
- Allowed calls: `loadToken()` and `isFresh()` ONLY. Never `accessToken()`,
  `refreshToken()`, `callTool()`, or any network refresh (spec AC7 / decisions.md D0).
- Logic:
  ```
  try {
    const t = await loadToken();            // reads S3/env/file; no refresh
    if (isFresh(t)) return { status: "ok",
      detail: "Cached access token fresh" };
    return { status: "unknown",
      detail: "Token present but access token not fresh — refresh not triggered" };
  } catch {
    return { status: "unknown",
      detail: "No Higgsfield token found (S3/env/local file)" };
  }
  ```
- Rationale for statuses: a missing token or a token whose cached access token is stale
  is a "needs setup/refresh" condition, not a live failure → `unknown`. We deliberately
  report `unknown` (never trigger a refresh) even in the hosted env-only case where
  `loadToken()` returns `{ access_token: "" }` and `isFresh` is false. Known, accepted
  conservative signal (see Risks).
- `loadToken()`'s S3 read is the only network in this check and is bounded by the shared
  timeout.

### 6.3 `seedance` — BytePlus ModelArk / Seedance  (CONFIG-PRESENCE)
- Recon §3: only billable generation + get-by-id endpoints exist; no list/account/ping.
  So config-presence only (spec AC8's explicit fallback).
- `process.env.ARK_API_KEY` set → `{ status: "ok", detail: "ARK_API_KEY set
  (config-presence only)" }`; unset → `{ status: "unknown", detail: "ARK_API_KEY not
  set" }`.
- No network, cannot time out.

### 6.4 `omni` — Gemini Omni Flash  (CONFIG-PRESENCE; see Trade-offs)
- Vertex mode (`OMNI_USE_VERTEX === "1"`): `GOOGLE_CLOUD_PROJECT` set → `ok`
  ("Vertex configured (config-presence only)"); unset → `unknown` ("OMNI_USE_VERTEX=1
  but GOOGLE_CLOUD_PROJECT not set").
- Default mode: `GOOGLE_API_KEY` set → `ok` ("generativelanguage configured
  (config-presence only)"); unset → `unknown` ("GOOGLE_API_KEY not set").
- No network (see Trade-offs for why we don't do the live ADC/metadata call here).

### 6.5 `postgres` — Railway Postgres
- Healthy predicate: `await db.execute(sql\`select 1\`)` resolves. (`db` from
  `@/lib/db`, `sql` from `drizzle-orm` — the exact pattern recon §3 confirms is already
  used in admin routes.)
- `ok`: resolves → `{ status: "ok", detail: "select 1 ok" }`.
- `error`: throws (bad/unreachable `DATABASE_URL`, connection refused) → propagates to
  `runCheck` → error with the driver message. There is no `unknown` case: `db.ts`
  always has a connection string (invalid placeholder fallback), so absence surfaces as
  a connection error, which is the honest signal.
- Timeout: `Promise.race` in `runCheck` (the pg query does not observe the AbortSignal).

### 6.6 `s3` — S3 media storage
- `status-checks.ts` holds its own module-level `S3Client` (region/creds from
  `AWS_REGION`/`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`, exactly like
  `higgsfield-mcp.ts` lines 25–31) and bucket from `AWS_S3_BUCKET_NAME ||
  "aistudio-media-bucket"`. This avoids touching `storage.ts` (whose client/`getBucket`
  are module-private).
- `unknown`: `AWS_ACCESS_KEY_ID` unset → `{ status: "unknown", detail: "AWS credentials
  not set" }`.
- Healthy predicate: `await client.send(new HeadBucketCommand({ Bucket: bucket }))`
  resolves. `HeadBucket` is a cheap, non-mutating metadata call (recon §3).
- `ok`: resolves → `{ status: "ok", detail: "HeadBucket <bucket> ok" }`.
- `error`: throws (403/404/network) → error via `runCheck`.
- Timeout: `Promise.race` (optionally also pass `{ abortSignal: signal }` to `send()`;
  not required for correctness).

---

## 7. Data flow

Happy path:
1. Admin clicks the **Status** tab (or the in-tab **Refresh** button). `StatusTab` sets
   `loading = true` and `GET`s `/api/admin/status` with `cache: "no-store"`.
2. Route: `adminOrNull()` → if null, 403. Else `runAllChecks()`.
3. `runAllChecks` records `checkedAt`, then `Promise.allSettled` over `CHECKS.map(d =>
   runCheck(d))` — all six start simultaneously (spec AC5).
4. Each `runCheck` races its `CheckFn` against a 5s timeout, measuring latency; slow
   checks resolve to an `error`/timeout result independently, never blocking peers
   (spec AC4).
5. Route serializes `StatusResponse` → 200 JSON.
6. `StatusTab` stores `results` + `checkedAt`, sets `loading = false`, renders one row
   per check with a colored status pill (ok=emerald, error=red, unknown=amber),
   `detail`, `latencyMs`, and a formatted `checkedAt`.

Error paths:
- Non-admin / expired session → 403; `StatusTab` shows an inline error notice ("Not
  authorized" / "Failed to load status") and no rows. (Middleware/route parity, spec
  AC6.)
- A single dependency down → that row is `error`/red with the failure `detail`; the
  other five render normally (spec AC9). No exception crosses the route boundary.
- The fetch itself failing (network) → `StatusTab` catch sets a top-level error string;
  Refresh remains clickable to retry.

---

## 8. Frontend `StatusTab` (contract)

- No props. Local state: `results: StatusCheck[] | null`, `checkedAt: number | null`,
  `loading: boolean`, `error: string | null`.
- `load()`: async; sets `loading`, fetches `/api/admin/status` `{ cache: "no-store" }`;
  on `res.ok` sets `results`/`checkedAt`, else sets `error`; `finally` clears `loading`.
  `useEffect(() => { load(); }, [])` on mount (mirrors `AdminDashboard`'s own
  `load`+`useEffect`, recon §1).
- Layout: a header row with the title + last-checked timestamp on the left and a
  **Refresh** button on the right (`onClick={load}`, disabled while `loading`, shows
  `<Loader2 className="h-4 w-4 animate-spin" />` when loading — recon §1 spinner
  convention). Below it, the table using the established table styling
  (`overflow-hidden rounded-xl border border-line` + `<table className="w-full
  text-sm">`, `thead` `bg-ink-800 text-left text-xs uppercase tracking-wide
  text-white/40`).
- Columns: **Dependency** (`name`), **Status** (pill), **Detail**, **Latency**
  (`{latencyMs} ms`), **Last checked** (localized time of `checkedAt`).
- Status pill classes (distinct visual treatment per AC9): `ok` → emerald text/badge,
  `error` → red, `unknown` → amber/`text-white/50`.
- While `loading` and `results === null`: show the `<p className="py-20 text-center
  text-white/40">Loading…</p>` placeholder. On refresh with existing results, keep the
  old rows visible and just spin the button (update-in-place, spec AC3).

---

## 9. Acceptance-criteria mapping

| # | Acceptance criterion | Satisfied by |
|---|----------------------|--------------|
| 1 | "Status" tab alongside Overview/Users/Logs/Pricing | `Tab` union + tab-bar entry + dispatch branch in `AdminDashboard.tsx` (File Plan / §2) |
| 2 | Opening tab checks all 6 deps, renders name/OK-Error-Unknown/detail/last-checked | `StatusTab` mount `useEffect` → `/api/admin/status` → `runAllChecks` returns 6 `CheckResult`s; table renders all fields (§8) |
| 3 | Visible Refresh re-runs checks, updates in place, no full reload | Refresh button `onClick={load}`, keeps prior rows, spins `Loader2` (§8) |
| 4 | Independent per-check timeout (5s); one hung dep doesn't block others | `runCheck` per-check `AbortController`+`Promise.race` at `CHECK_TIMEOUT_MS=5000` (§5) |
| 5 | Checks run in parallel | `Promise.allSettled(CHECKS.map(runCheck))` (§5/§7) |
| 6 | Route gated by admin auth like other `/api/admin/*` | `adminOrNull()` → 403 `{error:"FORBIDDEN"}`, `runtime="nodejs"` (§2 route, copies `data/route.ts`) |
| 7 | Higgsfield check never triggers refresh-token exchange | check 6.2 calls only exported `loadToken()`+`isFresh()`; never `accessToken`/`refreshToken`/`callTool` (§2 export, §6.2) |
| 8 | No billable generation call | Gemini = models-metadata GET; Seedance/Omni = config-presence; Higgsfield = read-only token; Postgres `select 1`; S3 `HeadBucket` (§6) |
| 9 | A failed check renders clearly, distinct, no crash | `Promise.allSettled` isolation + `runCheck` never rejects + red pill for `error` rows (§5, §7, §8) |
| 10| Results not persisted (live-only) | No DB writes anywhere; route computes and returns transient `StatusResponse`; no schema/table change (§2) |

---

## 10. Trade-offs

- **Gemini: live metadata call vs config-presence.** Chosen: live `GET /models/
  gemini-3-pro-image`. It is non-billable, and unlike a bare env-var check it actually
  proves the key is valid and `generativelanguage.googleapis.com` is reachable — the
  highest-value signal for the exact "is the image engine up?" question. Cost: one extra
  outbound request per refresh; acceptable for a manual, admin-only tool.

- **Omni: config-presence vs live ADC/metadata.** Chosen: config-presence. Recon §3
  found no free Omni metadata endpoint; a "real" check would either duplicate
  `resolveVertexAuth()` (requires exporting from `omni.ts` — violates the "only
  Higgsfield export" rule and the "don't touch provider files" instruction) or hit the
  billable Interactions API. The default deployment uses the generativelanguage path
  behind the same `GOOGLE_API_KEY` already exercised live by the Gemini check, so a
  separate live Omni call would be near-redundant. Deferred: a live Vertex ADC
  `getAccessToken()` probe (construct a local `GoogleAuth` in `status-checks.ts` without
  touching `omni.ts`) — noted as a cheap future enhancement, out of scope for v1.

- **Duplicating the Gemini API root/model constant** instead of exporting it from
  `gemini.ts`. Chosen: duplicate locally with a comment. The instruction is to keep
  provider files untouched except the mandated Higgsfield export; one duplicated URL
  string is a smaller footprint than widening `gemini.ts`'s public surface.

- **Own `S3Client` in `status-checks.ts`** rather than reusing `storage.ts`. `storage.ts`
  exposes neither its client nor `getBucket()`, and adding exports there is unnecessary
  scope. `higgsfield-mcp.ts` already sets the precedent of a self-contained client.

- **Inline `StatusTab`** vs a new component file. Chosen inline: `UsersTab`, `LogsTab`,
  `PricingTab` are all inline in `AdminDashboard.tsx`; a separate file would break the
  established convention for no benefit.

- **`import type` vs local interface for the client.** Chosen: local `StatusCheck`
  interface in the component. Avoids any risk of bundling the server-only
  `status-checks.ts` (db/aws-sdk) into the client, and matches the file's existing habit
  of re-declaring row shapes locally.

---

## 11. Out of scope

- No historical/uptime storage, graphs, or alerting (spec Non-goals; AC10).
- No auto-poll/interval refresh — manual Refresh only (spec A2).
- No per-provider quota/usage numbers (Pricing/Logs tabs own that).
- No public/non-admin status page.
- No live Omni Interactions/Vertex network probe (deferred; §10).
- No changes to generation routes, `storage.ts`, `db.ts`, or any provider file besides
  the two-line Higgsfield export.

---

## 12. Risks & mitigations

- **R1 — Higgsfield refresh accidentally triggered.** The whole feature's safety hinges
  on §6.2 calling only `loadToken`/`isFresh`. Mitigation: the export change is the only
  edit to that file; a reviewer can grep the diff for `accessToken(`/`refreshToken(`/
  `callTool(`/`refreshOnce(` in `status-checks.ts` and confirm zero hits (security
  review gate). D0 in decisions.md.
- **R2 — env-only hosted Higgsfield reports `unknown` while generation would still
  work.** `loadToken()` returns `access_token: ""` for the env-only path, so `isFresh`
  is false. This is intentional (we refuse to refresh to find out). Detail string makes
  it explicit ("refresh not triggered"). Documented; acceptable conservative signal.
- **R3 — a hung dependency ties up the request for the full 5s.** Bounded: worst case is
  ~5s because all six run in parallel under the same deadline. Well under the platform
  default function limit; the route does not need `maxDuration=60`. If a stricter budget
  is desired later, `runAllChecks(timeoutMs)` is parameterized.
- **R4 — `Promise.race` abandons but does not cancel non-fetch checks (pg/S3).** The
  abandoned promise settles later into nothing; no unhandled rejection because
  `runCheck`'s race already resolved. Connections are pooled/GC'd. Acceptable for a
  low-frequency admin tool.
- **R5 — client accidentally imports the server module.** Mitigated by the local
  interface decision (§10) and `runtime="nodejs"` on the route; `status-checks.ts` is
  never referenced from a `"use client"` file.

---

## 13. Test seams

Purely unit-testable from this document (Node `node:test` + `node:assert`, the existing
convention — no new dependency; see CLAUDE.md unit-test command):

- **`runCheck` timeout/measure logic** — inject a `CheckDef` with a synthetic `fn`:
  - `fn` resolves `{status:"ok",detail:"x"}` → result has that status/detail,
    `latencyMs >= 0`, `checkedAt` a number, `id`/`name` copied from the def.
  - `fn` rejects `new Error("boom")` → `{status:"error", detail:"boom"}`, never throws.
  - `fn` that resolves after `timeoutMs` (or never) → `{status:"error", detail:"Timed
    out after Nms"}`, and `runCheck` itself settles within ~`timeoutMs` (pass a small
    `timeoutMs`, e.g. 20ms, in the test).
- **`runAllChecks` aggregation** — pass a fake `checks` array (the `checks?` param is the
  seam) mixing ok/error/timeout defs → returns `{ checkedAt: <number>, checks: [...] }`
  with `checks.length === input.length`, order preserved, and a top-level `checkedAt`.
  Confirms one throwing/slow check never rejects the batch (AC5/AC9 at the unit level).
- **Config-presence checks** (`checkSeedance`, `checkOmni`) — pure functions of
  `process.env`; set/unset `ARK_API_KEY`, `OMNI_USE_VERTEX`, `GOOGLE_CLOUD_PROJECT`,
  `GOOGLE_API_KEY` and assert the `{status, detail}` mapping (ok vs unknown).
- **Response-shape contract** — assert the `CheckResult`/`StatusResponse` field set and
  types are stable (a schema-shape test the front-end can rely on).

Verifiable only by live network/credentials (out of scope for the automated suite —
manual verification in review, per CLAUDE.md "no test framework" for network paths):

- `checkGemini` (real HTTPS to generativelanguage), `checkPostgres` (real DB),
  `checkS3` (real `HeadBucket`), `checkHiggsfield` (real S3/file token read). These
  depend on live credentials and external reachability; unit tests would either be flaky
  or require billable/credentialed calls.
- The `StatusTab` React rendering (no React test harness exists in this repo) — verify
  manually via `/admin` in dev, including the error-row visual treatment and Refresh
  spinner.
```
