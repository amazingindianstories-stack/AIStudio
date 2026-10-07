# Migration status — 2026-10-07

Goal remains active. No production cutover or deployment has been performed.

| Measure | Current evidence |
|---|---|
| Django authoritative API methods | 0 / 84 |
| Node business route files remaining | 65 |
| ORM models implemented | 3 partial unmanaged read models / 21 declared application tables |
| Model design inventory | 21 / 21 declarations; live catalog audit pending |
| Schema authority | DRIZZLE |
| Auth authority | NEXT |
| Export worker | NODE |
| Generation worker | NODE |
| Providers transferred | 0 / 7 current provider modules |
| Production Django traffic | 0; no verified deployment |

Repository audit, historical evidence, ADR, static API inventory and initial
ownership guard exist. Per-method behavioral contracts remain incomplete.
Django health foundation and isolated qualification runner are implemented;
qualification results will be recorded after commands finish. Local PostgreSQL
is version 18; PostgreSQL 16 qualification remains required in CI.

Next gate: complete foundation qualification and CI, then authenticated settings
read contract parity. Actual deployed commit/catalog verification and production
operations remain authorization gates. Current worktree Asset Library changes
are preserved. Do not claim schema takeover or production parity from this stage.

Foundation verification: Django check passed; makemigrations --check --dry-run
reported no changes; 2 health/database-failure API tests passed against the
verified disposable PostgreSQL 18 cluster. Ownership guard passed: 65 files,
84 methods, 0 Django traffic owners. PostgreSQL 16 CI job is configured but has
not run remotely. Health-only Docker/Railway configuration is prepared; no service
has been deployed. Full model/schema, contract, browser and worker gates remain.

Settings read implementation: current HMAC cookie validation, disabled/version
checks, renewal, global limits and user overrides implemented. Five explicitly
discovered Django API tests pass; migration-state check passes. These fixtures
cover isolated read behavior, not full production schema equivalence. Node vs
Django HTTP contract comparison remains pending, so GET settings stays
IMPLEMENTING and Next-owned. Corrected CI root test discovery and supplied
explicit disposable AUTH_SECRET.

Current-source parser qualification: 17 inputs compared directly against
`src/lib/limits.js` via a pure Node oracle. Unicode whitespace, non-ASCII
digits, parseInt prefix behavior, IEEE-754 rounding and overflow now agree.
Six explicitly discovered Django tests pass. GET settings has a detailed
method contract; HTTP/header/DB-effect parity and preview remain pending.

Real settings HTTP qualification now passes seven scenarios against current
Next and Django servers with disposable PostgreSQL: status/JSON, content type,
renewal presence/flags and unchanged DB snapshots. See settings-qualification.md.
Production Secure-cookie/token interoperability, PostgreSQL 16 CI, broader
headers, browser preview and performance remain open; ownership stays Next.

Renewed-cookie interoperability passes all four issuer/consumer combinations,
with equal 30-day max-age and no immediate re-renewal. Real HTTP parity is now
wired into the PostgreSQL 16 CI job; remote execution remains pending.
