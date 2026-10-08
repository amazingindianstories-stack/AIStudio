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

Real login HTTP qualification passes independently for Next/Django: missing
credentials, successful normalized login, cross-runtime accepted cookies,
nonexistent-account failures and sixth-attempt throttle. DB attempt/audit event
invariants match. All existing HTTP suites still pass. See login-qualification.md
for open security/input/browser/hosted gates. No auth cutover or deployment.

Logout implemented and qualified via focused Django test plus actual Next/Django
HTTP requests: anonymous/authenticated ok:true, HttpOnly path=/ max-age=0 cookie
without SameSite, and exactly one authenticated logout audit event. Aged-session
renewal cannot replace the cleared cookie. Full HTTP harness passes again.
Logout and auth traffic remain Next-owned; hosted/security/browser gates remain.

Password PATCH implemented with current validation, scrypt replacement, guarded
active/auth-version UPDATE, incremented version, cookie reissue and audit event.
Three focused DB/API tests pass: success invalidates old token; incorrect current
password leaves version unchanged; concurrent version change returns 409, clears
cookie and preserves hash without audit. Actual Node/Django password HTTP parity,
security/browser/hosted gates remain. Production auth remains Next-owned.

Password real HTTP qualification passes for both current runtimes: wrong-password
nonmutation, successful hash/version/audit effects, and cross-runtime old-cookie
rejection/new-cookie acceptance. Full HTTP harness passes again. See
password-change-qualification.md for unqualified security/concurrency/browser
cases. Production auth and all business traffic remain Next-owned.

Repository integration qualification: all 1063 Node unit tests pass, lint passes,
and Next production build passes in the credential-free disposable checkout.
Initial two unit failures came from omitted progress.md and absent local Git
metadata required by packaging tests; isolation runner now copies that document
and creates an independent index containing only copied source, never the user's
Git metadata or generated packaging output. Browser/DB migration/full Django
schema/hosted qualification remain separate, incomplete gates.

Browser mutation security correction added: exact trusted Origin allowlist for
unsafe API methods; reject untrusted/null origins and origin-less cross-site
Fetch Metadata. Production requires HTTPS frontend origins. Focused auth test
proves rejection precedes DB/audit effects, trusted Origin reaches validation.
Hosted proxy/browser qualification remains mandatory and unverified; no cutover.

Actual Origin security HTTP qualification: nine rejection cases across login,
logout and password changes pass; trusted frontend Origin reaches validation.
Application snapshots plus attempts/audit counts are unchanged after denials.
Full HTTP harness still passes. See origin-security-qualification.md; hosted
browser/proxy behavior remains pending. No production routing or secrets changed.

2026-10-08: Declared index coverage expanded to all 33 current Drizzle indexes
in runtime/disk Django state. Isolated qualification: 66 physical index checks,
24 scoped uniqueness insert checks, seven no-op migration SQL checks and 42
Django tests pass. Full schema equivalence remains open; authority unchanged.

2026-10-08: Added two current CHECK constraints to unmanaged Django runtime/disk
state; four canonical catalog comparisons and 57 source/runtime/disk insert
checks pass. Migration is state-only; 42 Django tests pass. Schema gate open.

2026-10-08: Added all 46 current declared database defaults to unmanaged Django
runtime/disk state. 410 catalog comparisons, 573 literal/absent SQL values, 42
UUID fallbacks and 92 ORM default checks pass. Ten migrations emit no DDL;
42 Django regression tests pass. Full schema takeover remains open.

2026-10-08: Whole-schema reproduction probe finds five differing catalog
categories; the explicit equivalence gate exits 1. Recorded physical FK, implicit
index, naming/order and function/trigger gaps. Scratch schema rolled back;
Django-only baseline and production equivalence remain unproven.

2026-10-08: Explicit relation index state removes six unintended FK indexes
from fresh Django reproduction (72 → 66 total; current fixture 58). All 33
declared indexes, column/FK guards and 42 tests pass. Four new migrations emit
no DDL. Eight text pattern indexes and other baseline differences remain.

2026-10-08: Scoped PostgreSQL schema editor suppresses eight automatic text
pattern indexes absent from current declarations. Fresh reproduction index count
is now 58 vs current 58, with naming/other catalog differences still open.
Sixteen suppression checks, unrelated-index control and 42 tests pass.

2026-10-08: Fresh Django FK SQL now preserves seven current names and immediate
RESTRICT/CASCADE rules. Twenty-eight physical cases and 42 regression tests pass;
source fixture FK aliases and broader schema gaps remain. No production DDL.

2026-10-08: Fresh table key names now match; all 58 physical index catalog rows
are equal in local full reproduction. Four catalog categories remain unequal.
42 regression tests pass; production/baseline takeover remains open.

2026-10-08: Ported four current functions/five triggers into versioned Django
baseline SQL. Exact catalog comparison and existing invariant behavior pass on
both isolated reproduced schemas. Two catalog categories remain unequal;
active migration graph and schema authority remain unchanged.

## Checkpoint schema work, carried into the blueprint

### Additive foreign-key aliases preserved in baseline SQL

The pending Django baseline now includes frozen, idempotent SQL for the five
foreign-key aliases created by the current hierarchy and naming migrations.
The reproduction probe rejects source drift, applies these statements twice,
and CI requires exact constraint catalog agreement. Isolated PostgreSQL 18
qualification matched all 167 constraints, 58 indexes, four functions and five
triggers; invariant behavior passed on both fixtures and scratch schemas were
rolled back. The remaining catalog difference is ordinal position for 79
columns; column types, nullability and defaults agree.

This is still a diagnostic reconstruction, not an executable authoritative
Django migration baseline. Production catalog audit, baseline review and schema
ownership transfer remain outstanding. Drizzle retains schema authority and
Django owns no production routes. Clean-checkout qualification still depends on
integration of the separate Asset Library folder-color migration work.

### Full diagnostic catalog agreement

Six state-only migrations now freeze the current declared column order for
future baseline creation. They emit no DDL and never reorder or rebuild an
existing database table. The operation rejects missing, duplicate or unknown
fields. PostgreSQL 18 reconstruction now matches every catalog category:
21 tables, 205 columns including ordinal positions, 167 constraints, 58 indexes,
four functions and five triggers. Both invariant fixtures pass and both scratch
schemas roll back. CI now requires full diagnostic equivalence.

`makemigrations --check --dry-run` reports no changes. All six ordering migrations
were checked for zero emitted DDL and three invalid orders were rejected.
This removes the previous column-order gap, but does not establish schema
ownership: an executable Django baseline, actual production catalog comparison,
reviewed baselining and the deployment gates are still required. The separate
untracked folder-color migration remains a clean-checkout qualification dependency.

The isolated Django regression suite also passed all 42 tests.

### Candidate baseline executed through Django migrations

`backend/baseline_candidate` now supplies an executable candidate graph: 21
CreateModel operations plus one RunSQL migration for invariant functions,
triggers and FK aliases. The isolated PostgreSQL 18 probe applies all 22
migrations through MigrationExecutor, verifies an empty subsequent plan, and
compares every catalog category with the current source fixture. Exact agreement
and both invariant behavior checks passed; scratch schemas rolled back. Django's
recorder is included on both sides (22 total tables, 209 columns, 172 constraints,
59 indexes, one sequence), with no catalog differences excluded.

CI includes executor qualification. Evidence is `schema-executor-evidence.json`.
This advances beyond manual diagnostic reconstruction, but the candidate remains
outside production settings. PostgreSQL 16 execution, committed fresh-database
qualification, existing-history reconciliation, actual production catalog audit,
backup/PITR and reviewed baseline activation remain pending. Drizzle retains
schema authority; route ownership and production traffic are unchanged.

### PostgreSQL 16 committed baseline qualification

The isolated Python 3.12 container applied all 22 candidate migrations to a fresh
PostgreSQL 16.15 database with real commits. After reconnecting, all migration
records persisted and the plan was empty. The complete catalog matched the
current-source database: 21 application tables plus Django bookkeeping, 209
columns, 44 constraints, 59 indexes, four functions, five triggers and one
bookkeeping sequence. PostgreSQL 16 does not expose NOT NULL constraints as the
separate catalog entries counted on PostgreSQL 18; comparison was within PG16.

Both databases passed the existing 11 hierarchy/naming behavior checks with real
transaction boundaries. The Django-created database also passed 60-field image,
video and depth ORM roundtrips, five history-count checks, eight history and eight
update checks, and bounded page query measurements. No provider calls occurred.
The harness also passed its five settings cases and database-outage recovery.
Temporary containers, both databases and their internal network were removed.

Evidence: `schema-pg16-baseline-evidence.json`. Reproduce via the isolated runner
with `container-build.py --runtime --declared-schema --invariants --baseline`.
Actual production audit, existing Django history reconciliation, backup/PITR,
reviewed baseline activation and route transfers remain outstanding. The separate
folder-color work must still be integrated for clean-checkout qualification.
