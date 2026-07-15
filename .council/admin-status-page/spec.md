# Spec: Admin API Status Page

## Problem

Admins have no visibility into whether the app's external dependencies (image/video
generation providers, storage, database) are currently reachable and healthy. When a
generation fails, the admin has to guess whether it's a code bug, a provider outage, or
a credentials/config problem (e.g. the Higgsfield token — see
`.claude/.../higgsfield-token-family.md`: refresh tokens are single-use and the whole
family gets revoked on reuse; recovery is manual). A dedicated status page lets an admin
check "is everything up" at a glance and re-check on demand.

## Desired behavior

- A new tab in the existing `/admin` dashboard (`src/components/AdminDashboard.tsx`,
  which already has Overview/Users/Logs/Pricing tabs) titled **"Status"**.
- On opening the tab, the app runs a live health check against every external
  dependency the app relies on and renders each as a row/card: name, status
  (OK / Error / Unknown), a short detail string (e.g. status code, latency, or error
  message), and "last checked" time.
- A **Refresh** button re-runs all checks on demand and updates the results in place
  (with a loading state per row or globally while in flight).
- Checks run in parallel server-side, each with its own timeout, so one hung dependency
  doesn't block the others or hang the page.
- Admin-only: reuses the existing `requireAdmin`/`adminOrNull` gate — same as every
  other `/api/admin/*` route.

## Scope of "all APIs" (stated assumption — this is the one real ambiguity in the
request, resolved with a default rather than a user round-trip)

The app's external dependencies, per `CLAUDE.md`'s Providers section and `src/lib/`:

1. **Gemini / Nano Banana Pro** (`generativelanguage.googleapis.com`, `GOOGLE_API_KEY`) — `src/lib/providers/gemini.ts`
2. **Higgsfield MCP** (`https://mcp.higgsfield.ai/mcp`, OAuth) — `src/lib/providers/higgsfield-mcp.ts`
3. **BytePlus ModelArk / Seedance** (`ARK_BASE_URL`, `ARK_API_KEY`) — `src/lib/providers/seedance.ts`
4. **Gemini Omni Flash** (generativelanguage or Vertex, gated by `OMNI_USE_VERTEX`) — `src/lib/providers/omni.ts`
5. **Postgres** (Railway, via `src/lib/db.ts`)
6. **S3 media storage** (`src/lib/storage.ts`, `AWS_S3_BUCKET_NAME`)

Assumption: "all APIs" means all six of the above (the four generation providers plus
the two infrastructure dependencies), since an operational status page is more useful to
an admin if it also flags "DB is down" or "storage is unreachable" rather than only
generation providers. Logged in the Decision Log; user can veto/narrow this.

## Hard constraint — Higgsfield token safety (non-negotiable)

Per prior incident (`.council`/memory: token family single-use, revoked on reuse, no
automated recovery), the Higgsfield health check **must never trigger a refresh-token
exchange**. It must only:
- confirm a token is present (file locally, or `HIGGSFIELD_MCP_REFRESH_TOKEN`/`HIGGSFIELD_MCP_CLIENT_ID`/S3-persisted token when hosted), and
- if an unexpired cached access token exists, optionally make one cheap authenticated
  read-only MCP call with it (never a call that 401s-and-refreshes on failure — if the
  cached access token is missing/expired, report "unknown/needs refresh" rather than
  refreshing).
This must be spelled out explicitly to the architect and re-verified in security review.

## Acceptance criteria

1. `/admin` has a "Status" tab alongside Overview/Users/Logs/Pricing.
2. Opening the tab triggers a check of all 6 dependencies above and renders a status
   row for each: name, OK/Error/Unknown, detail string, last-checked timestamp.
3. A visible "Refresh" control re-runs all checks and updates results without a full
   page reload.
4. Each check has an independent timeout (default 5s) — one slow/hung dependency does
   not prevent the others from reporting.
5. Checks run in parallel (not sequentially).
6. The status route is gated by admin auth exactly like other `/api/admin/*` routes;
   non-admins get 403/redirect, same as today.
7. The Higgsfield check never performs a refresh-token exchange (see constraint above).
8. No generation provider check incurs billable cost (no real image/video generation
   call is made to check status — must use a lightweight auth/metadata call or,
   where no such call exists cheaply, a config-presence check).
9. A failed check for one dependency renders clearly (distinct visual treatment) and
   does not throw/crash the page or the other rows.
10. Status results are not persisted to the DB (live-only) — v1 has no historical
    uptime log.

## Non-goals

- No historical/uptime tracking, graphs, or alerting (future extension).
- No auto-polling/background interval refresh — manual refresh only in v1.
- No per-provider quota/usage numbers (that's the existing Pricing/Logs tabs' job).
- No public (non-admin) status page.
- Not a replacement for real APM/monitoring — this is an at-a-glance internal tool.

## Assumptions log (also mirrored into decisions.md once design starts)

- A1: "all apis" = the 4 generation providers + Postgres + S3 (see Scope section).
- A2: Manual refresh only, no auto-refresh interval, in v1.
- A3: No persistence of check results/history in v1.
- A4: Default per-check timeout of 5 seconds.
