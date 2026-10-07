# Migration status — 2026-10-07

Goal remains active. No production cutover or deployment has been performed.

| Measure | Current evidence |
|---|---|
| Django authoritative API methods | 0 / 85 |
| Node business route files remaining | 65 |
| ORM models implemented | 6 partial unmanaged read models / 21 declared application tables |
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
85 methods, 0 Django traffic owners. PostgreSQL 16 CI job is configured but has
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

Ownership guard hardening: arrow/aliased method exports are inventoried; new
registered Node routes require a base-relative, exact-content exception. Three
rejection-path tests pass. Schema/provider/worker source hashes are recorded
for future takeover checks; Python ownership rejects remaining Node execution
modules. This does not transfer any domain or schema authority.

Same-origin method routing prepared: explicit GET settings selection, HTTPS
origin validation, fail-closed errors and disabled default. Three routing tests
pass. Real Next middleware rewrite reached isolated Django with equal JSON and
Django request ID. Seven direct HTTP parity cases still pass. No deployment or
production routing configuration changed.

Production-setting qualification: seven Django tests pass, including Secure /
HttpOnly / Lax 30-day renewal and request-log exclusion of cookie/query content.
Structured INFO logs are enabled on stdout. Database URL TLS options are retained
and unsupported options rejected; production allowed hosts must be explicit.
Gunicorn raw access logs are disabled to avoid future signed-grant query leaks.
No Railway service has been created or deployed.

Current hierarchy GET implementation added to library/projects domain apps, with
unmanaged model state. Nine Django tests pass, covering root/parent scope,
ancestry, colors, tree precedence and response shape. GET folders remains
IMPLEMENTING/Next-owned; malformed-ID/error behavior, live HTTP parity,
performance and browser qualification remain. Routing allowlist still contains
only GET settings. No folder mutations or schema authority transferred.

Folder real HTTP comparison passes nine scenarios with equal status/JSON and
unchanged database snapshots. Repeated query parameters now use first-value
semantics matching current Next. See folder-read-qualification.md for coverage
and remaining cases. Settings HTTP parity and same-origin rewrite still pass.

Schema evidence collector added and qualified against disposable PostgreSQL.
Real DDL comparison detects changed tables, columns/defaults, constraints and
indexes; ten Django tests pass. Collector also records custom triggers,
functions and extensions, whose specialized fixtures remain pending. Complete
Django baseline and production schema equivalence are still unimplemented;
schema authority remains DRIZZLE.

Catalog qualification extended: actual function-body changes, disabled deferred
constraint triggers, sequence increments and enum definitions are detected.
Sequence/enum/domain metadata is captured; incomplete or malformed category
snapshots fail closed. Full ten-test suite passes, with focused comparator
checks rerun after validation tightening. No schema equivalence claim is made.

Material-library GET implemented in assets domain from current assets-db.js.
Preserves all-assets unfiltered visibility, project-only filtering, descending
createdAt order, omitted null description/projectId, and first repeated query
value. Eleven Django tests pass. GET assets remains IMPLEMENTING/Next-owned;
real HTTP parity, errors/browser/performance and storage qualification remain.
No asset mutation or provider/storage side effect was implemented or invoked.
