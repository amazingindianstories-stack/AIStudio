# Migration status — 2026-10-07

Goal remains active. No production cutover or deployment has been performed.

| Measure | Current evidence |
|---|---|
| Django authoritative API methods | 0 / 85 |
| Node business route files remaining | 65 |
| ORM models implemented | 8 partial unmanaged models / 21 declared application tables |
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

2026-10-08: five actual asset HTTP comparisons pass against current Next and
Django on a fresh verified disposable cluster. Status/JSON and unchanged DB
snapshots agree. Seven settings/nine folder comparisons and same-origin settings
rewrite also pass again. See asset-read-qualification.md. Production ownership,
schema authority and worker authority remain unchanged.

Current-user GET implemented from current Next behavior. Thirteen Django tests
pass, plus five actual current-user HTTP comparisons: anonymous/invalid/version
mismatch returns 200 user:null and clears cookie, public user fields match,
renewal max-age/flags match, DB snapshots unchanged. Other HTTP suites still
pass. Auth issuer/production traffic remain Next; profile PATCH is not ported.

Project GET implemented with current advisory lock 815042 and default creation
semantics. Fifteen Django tests pass, including twelve concurrent empty-table
calls producing exactly one default. Two populated-fixture HTTP comparisons
match Next status/JSON with unchanged DB. Empty-database cross-runtime parity,
project-folder association coverage, browser and production remain pending.
Project mutations remain Next-owned; no route selection changed.

Project GET qualification extended: populated HTTP parity includes project folder
association; independent empty-table creation and stable repeat reads pass for
both runtimes. Twelve mixed Next/Django concurrent HTTP requests return one
shared default project ID and one DB row. See project-read-qualification.md.
All other HTTP comparisons and same-origin rewrite still pass. No cutover.

Password compatibility foundation qualified directly against current Node source:
Python verifies Node scrypt hashes and Node verifies Python hashes for synthetic
ASCII/Hindi/emoji/lone-surrogate passwords. Preserves textual hex salt, 64-byte
scrypt output, UTF-16 validation length and Node UTF-8 replacement behavior.
Focused interoperability test passes. Login/password mutations, throttling,
audit logging and auth authority transfer remain unimplemented/unqualified.

Login-throttle foundation implemented from current login-throttle.js using the
existing login_attempts table. Two isolated DB tests pass: normalized nonexistent
identifier failures, expiry boundary cleanup, retry timing and disabled gate
without cleanup. Unmanaged migration state is recorded; no schema DDL is
issued for this model. Direct Node throttle parity and login HTTP qualification
remain pending. Authentication issuer and traffic authority remain Next.

Throttle source parity: seventeen environment parsing cases, retry boundaries
and admission decisions agree directly with current Node login-throttle.js.
Corrected Python-only acceptance of numeric underscores/non-JS whitespace.
Three focused source/database tests pass. Login HTTP behavior remains pending.

Django login implementation added using qualified password/throttle helpers,
compatible session cookie, disabled-account checks and best-effort login audit.
Current user credential fields and activity_logs recorded as unmanaged state.
Full current Django suite passes 21 tests. Login remains IMPLEMENTING/Next-owned;
real Node/Django login HTTP/DB-effect parity, malformed-input coercion, unsafe
Origin/CSRF qualification, browser/preview and issuer cutover remain pending.
No deployment or schema authority change occurred.
