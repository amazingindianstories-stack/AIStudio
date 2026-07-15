# Recon — Admin API Status Tab

## 1. `src/components/AdminDashboard.tsx` — tab system

- `type Tab = "overview" | "users" | "logs" | "pricing";` (line 91). Tab state: `const [tab, setTab] = useState<Tab>("overview")` (line 96).
- Tab bar (lines 159–183): array of `[id, label, Icon] as const` mapped to buttons; active styling via `cn(..., tab === id ? "bg-ink-650 text-white" : "text-white/55 hover:text-white")`. Add `["status", "Status", <icon>]` here and a new union member.
- Render dispatch is an if/else-if chain gated on `!data` loading (lines 185–195): `!data ? <Loading/> : tab === "overview" ? <Overview/> : ... : <PricingTab/>`. A new tab needs its own conditional branch; the Status tab's own data (health checks) is independent of the single `data` blob fetched via `load()`/`/api/admin/data` — it should self-fetch on mount, not block on `data`.
- Component convention: each `*Tab({ data, reload })` receives the shared `Data` object and a `reload: () => void` callback (e.g. `PricingTab` line 1333). A Status tab won't need `data`/`reload` from the parent; it will have its own local `load()`+`useEffect` exactly like `AdminDashboard` itself (lines 100–117), fetching `/api/admin/status`.
- Styling conventions to match: card = `rounded-xl border border-line bg-ink-800 p-4` (`Panel`, line 221); stat tile = `Stat` (line 212); table = `overflow-hidden rounded-xl border border-line` + `<table className="w-full text-sm">` with `thead` `bg-ink-800 text-left text-xs uppercase tracking-wide text-white/40` (e.g. `PricingTab` 1348–1376); loading spinner = `<Loader2 className="h-4 w-4 animate-spin" />` (lucide-react); button = `rounded-lg border border-line bg-ink-700 px-3 py-1.5 text-sm text-white/80 hover:text-white`; success/error notice = `AdminNoticeLine` (line 1081) with emerald/red text.

## 2. `/api/admin/*` route auth pattern

All routes use `adminOrNull()` (`src/lib/admin.ts:4`, wraps `getSession()`), never `requireAdmin` (reserved for page/server-component contexts that throw — `src/lib/auth.ts:128`). Pattern: `const me = await adminOrNull(); if (!me) return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });` at the top of every handler. All routes set `export const runtime = "nodejs";`. Errors return `NextResponse.json({ error: "..." }, { status: 4xx })`; success returns a plain object, no envelope. A new `/api/admin/status/route.ts` GET handler should follow `data/route.ts`'s exact shape (gate → `Promise.all`/`allSettled` of independent checks → single JSON response).

## 3. Per-dependency cheapest health check

- **Gemini/NBP** (`gemini.ts:106`): only `GOOGLE_API_KEY` + billable `generateContent` exists. No metadata call in-repo. Cheapest non-billable check: a **new** `GET {API_ROOT}/models/{MODEL}` metadata call with `x-goog-api-key` header — written from scratch.
- **Higgsfield MCP** (`higgsfield-mcp.ts`): token state is module-global `let token: TokenData | null = null` (line 57). `readS3Token()`/`writeS3Token()` are read/write-only, no refresh. `loadToken()` (line 87) loads from S3→env→local file but does **not** refresh. `isFresh(t)` (line 124, pure) checks token freshness with a 300s safety margin. `accessToken()` (line 187) and `refreshToken()` (line 133) both call/trigger refresh and **must be avoided** in a health check. `callTool()` (line 304) internally calls `accessToken()` and retries `refreshToken()` on 401 — unsafe to reuse as-is. **Health-check path: call `loadToken()` + `isFresh()` directly only; report "unknown/needs refresh" if not fresh; never call `accessToken()`/`refreshToken()`/`callTool()`.**
- **Seedance/BytePlus** (`seedance.ts`): `arkBase()`/`arkKey()` only; only endpoints are billable generation + a get-by-id (needs an id). No list/account endpoint. Health check must be **config-presence only** (`ARK_API_KEY` set).
- **Omni Flash** (`omni.ts`): `OMNI_USE_VERTEX=1` switches to `resolveVertexAuth()` (ADC via `google-auth-library`) vs. default `GOOGLE_API_KEY`. No lightweight endpoint exists. Vertex path: verify `auth.getAccessToken()` succeeds (ADC reachable) without hitting the API. Non-Vertex: config-presence only (`GOOGLE_API_KEY` set) — same limitation as Gemini/NBP.
- **Postgres** (`db.ts:20-26`): module-level Drizzle client over `postgres()`. Trivial check: `await db.execute(sql\`select 1\`)` (import `sql` from `drizzle-orm`, already used elsewhere in admin routes).
- **S3** (`storage.ts:17-25`): module-level `S3Client`, bucket via `getBucket()`/`AWS_S3_BUCKET_NAME`. No `HeadBucket` call exists; add `HeadBucketCommand` from `@aws-sdk/client-s3` — cheap, non-mutating.

## 4. Timeout patterns

No `AbortController`/`Promise.race` usage anywhere in `src` today. Existing "timeout" idioms are deadline-loop polling and stored-timestamp staleness checks, not a per-request abort pattern. The new status route needs to introduce `AbortController` + `fetch(..., { signal })` and/or `Promise.race` for a 5s timeout wrapper — no precedent to mirror; keep it local/simple rather than a premature shared abstraction unless the architect finds real reuse across ≥3 checks.
