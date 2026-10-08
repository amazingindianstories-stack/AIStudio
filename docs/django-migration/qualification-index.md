# Qualification index — 2026-10-08

Local current evidence: 26 Django tests passed after Origin protection; 1063 Node
unit tests, lint and production build passed in the isolated copy. HTTP harness
passes settings, folder, asset, current-user, populated/default projects,
login/logout/password and Origin checks. These are not production acceptance.

Read domain evidence: settings-qualification.md, folder-read-qualification.md,
asset-read-qualification.md, project-read-qualification.md.
Auth evidence: login-qualification.md, password-change-qualification.md,
origin-security-qualification.md. Current-user checks live in the HTTP harness.
Schema collector coverage and limits are recorded in model-design.md.

Next required gates: malformed/error contracts, real browser qualification,
PostgreSQL 16 CI and full-schema integration, hosted same-origin forwarding,
reviewed early Railway deployment, production canary and rollback observation.
Full production-schema baseline/equivalence, remaining APIs and media/provider
contracts, schema takeover and subsequent Python worker transfers are incomplete.
No domain has been deployed or removed from Node. Eight unmanaged models are
partial qualification infrastructure, not the final Django schema system.

Original complete scope and acceptance criteria remain in source-request.txt.

Mixed-runtime password race qualification passes one concurrent run with exactly
one winning hash/version/audit mutation. Barrier-controlled cross-runtime stress
coverage remains pending; see password-change-qualification.md for exact scope.

Local real Chromium settings transport passes through the Next/Django rewrite,
including HttpOnly/Lax renewal receipt. This controlled-page contract does not
replace the full application browser suite or hosted preview qualification.

Gunicorn production-settings qualification passes the full HTTP harness with
two WSGI workers, explicit trusted origins/allowed hosts and disposable local
PostgreSQL. Health checks process/database readiness; login and password cookies
carry Secure. CI includes this runtime variant. It is not a container/Railway
or hosted TLS qualification; Secure-cookie browser forwarding needs HTTPS and
cannot be inferred from manually supplied cookies over local HTTP.

Settings read performance qualification: six admin-dashboard tests pass after
restricting global/personal reads to registered keys. A fixture with 4,000
unrelated rows verifies three queries and correct limits. The production-settings
Gunicorn HTTP harness passed again after this change. Hosted/load baselines
remain pending; see settings-qualification.md for the precise evidence scope.

External deployment reconciliation now identifies existing Django-like Railway
services with runtime versions different from this checkout. Declared ownership
has not changed, but actual live routing/source remain unproven. See
railway-api-release.md; do not interpret the manifest as deployed-source evidence.

Local API BuildKit image build and network-disabled file/import inspection pass:
56 application files, no unexpected files, Django 5.2.18 / DRF 3.18.3 /
Gunicorn 23.0.0. The check corrected a broad Docker ignore exception. Container
HTTP/database qualification and hosted deployment remain pending.

Container health/database qualification now passes against disposable tmpfs
PostgreSQL 16.15 on an internal Docker network: readiness 200, DB outage 503,
recovery 200, no-store/request IDs and sanitized structured logs. Cleanup was
verified. This supersedes the preceding container-HTTP-pending statement for
health only; business/schema/hosted qualification remains incomplete.

Container settings qualification now passes five scenarios on PostgreSQL 16.15,
including unchanged DB snapshots and Secure renewal accepted by follow-up HTTP.
This supersedes business-pending for this minimal settings fixture only; full
schema, browser TLS and hosted qualification remain incomplete. Details are in
settings-qualification.md.

The settings container variant also passes against the entire current Drizzle
declared table set (21 tables) on disposable PostgreSQL 16.15. This replaces
partial-table DDL for that variant. Migration-script invariants, old-schema
upgrades and Django schema equivalence remain unqualified.

The container schema variant can now install the current exported hierarchy
(38) and naming (17) SQL statements atomically per domain and apply each twice.
A run passed with four public functions/five non-internal triggers and settings
contracts. An initial run failed at the settings subprocess without sufficient
stderr diagnostics; its cause remains unresolved, so stable qualification is
not established. Diagnostics now retain synthetic-container stderr. Behavioral
invariant tests, other migration scripts and upgrade/equivalence gates remain
pending.

Current-schema PostgreSQL reference behavior now passes eleven hierarchy/naming
checks in the disposable PG16 container: normalization, sibling uniqueness,
child scope, restricted parent deletion, auto naming, generation scope,
namespace integrity, positive sequence, deferred scope move, naming reassignment
and cascade deletion. Settings and deterministic connection recovery also pass
in that run. These use current Node migration SQL and do not prove a Django
migration baseline, concurrent naming allocation, cycles or complete invariants.

Machine-readable GET contract details now cover settings, folders, assets,
projects and current-user reads, including side effects, ordering, query
precedence, cookie behavior and remaining qualification. The ownership CI guard
also checks exact route/method inventory correspondence and required dimensions
for documented methods. Five guard rejection tests pass, and the complete
65-route/85-method check reports zero errors in a newly verified isolated copy.
These are documentation/structural checks; other methods remain inventoried
with pending contract review, and no parity or traffic state was promoted.

Request observability now includes `user_id` only after active/auth-version DB
session validation or successful password verification at login. The outer
middleware reads identity from the underlying DRF HttpRequest; anonymous/invalid
sessions do not contribute an actor. Email, cookies and query values remain
excluded. The full 28-test Django suite passed after adding actor/privacy tests
in the fresh verified disposable session (Python 3.14/local PostgreSQL 18).
Production-image Python 3.12 and hosted observability remain separate evidence.

Three current-schema library persistence models are added: organizational
idempotency keys, naming counters and generation naming. An isolated ORM test
passes UUID/text PK, nullable Unicode JSON and exact bigint roundtrips. The
library test label passed nine discovered tests (including imported settings
tests); this is not nine new library cases. Model-state drift check passes and
SQL inspection confirms migration 0002 emits no application DDL. Declaration
coverage is now 11/21, still partial/unmanaged; FK/default/index/trigger baseline
and schema takeover remain incomplete. Runtime/traffic ownership is unchanged.

PortraitGroup/PortraitAsset unmanaged declarations now represent the current
portrait columns, nullable unique provider IDs, Python defaults and group
relationship. The relationship is explicitly retained in migration state.
Model-state drift check passes; physical schema/default/index/CASCADE equivalence
and portrait API/provider qualification are still pending. Declaration count is
13/21; no traffic, provider or schema authority has transferred.

Two isolated portrait persistence tests pass: nullable provider IDs permit
multiple unset values, non-null provider IDs remain unique, Unicode group names
and declared Python defaults roundtrip, select_related resolves group_id, and
direct SQL group deletion cascades to assets under the fixture's current-schema
FK. These use explicitly created disposable tables, not Django-created physical
schema, and invoke no portrait provider or storage service. Migration baseline
equivalence and portrait API behavior remain pending.

Pricing now has an unmanaged current-schema declaration: text model primary key,
integer unit_cost_cents, unit and nullable notes. Model-state drift check passes;
SQL inspection confirms its state migration is a no-op for application DDL.
Declaration coverage is 14/21. Pricing admission/business behavior and physical
schema baseline remain pending; no pricing HTTP route or authority transferred.

CanvasBoard, AgentConversation and AgentConversationMessage now have unmanaged
current-column declarations in their own domain apps. Conversation messages
retain a plain conversation_id UUID because current Drizzle declares no FK;
legacy kind and nullable agent_kind/tool_trace remain represented. Isolated
model-state drift check passes, and both initial migrations emit only no-op
model operations, with no application DDL. Declaration coverage is 17/21.
Physical UUID defaults, conversation indexes (including names longer than
Django's normal index-name limit), schema equivalence, persistence/API behavior
and traffic qualification remain pending. No schema or traffic authority changes.

Generation, DepthWorker, MediaExport and MediaExportItem now complete table-level
unmanaged declaration coverage (21/21). Generation keeps nullable project/folder
relations with RESTRICT semantics and the current 60 columns; exports retain the
(export_id,generation_id) composite key and export CASCADE relation. Relations
are explicitly present in migration state because unmanaged autodetection omits
them. Model-state drift check passes, and SQL inspection of all three initial
migrations confirms no application DDL. Physical defaults/indexes/triggers,
complete constraint equivalence and Django-only schema creation remain pending.

The full isolated Django suite passes 34 discovered tests on Python 3.14/local
PostgreSQL 18. Three new export/depth persistence cases cover composite lookup,
unique keys, SQL export deletion cascade, Unicode .mov filenames, independent
JSON defaults, exact bigint values and persisted claim UUIDs. Fixtures create
current-shaped disposable tables; these are not schema baseline or worker
execution proofs. CI labels now include all newly registered domain apps;
remote CI/PostgreSQL 16 evidence remains pending. No external providers, storage,
GPU workers, production schema or routing were invoked.

Declared schema guard (`model-columns.py` + `declared-columns.mjs`) now compares
all 21 tables and 205 physical columns against both runtime models and disk
migration state: SQL types, nullability, ordered primary keys, FK source/target
columns and deletion policies. It imports Drizzle metadata without opening a
Node connection and loads Django disk migration state without executing SQL.
The first FK check exposed missing folder project/parent and generation-naming
relationships; these are corrected in unmanaged state migration library 0003.
SQL inspection confirms every operation is no-op for application DDL. Column/FK
guard and model drift check pass. All 34 Django tests and five negative-control
guard tests pass in the verified disposable local session. CI now runs the guard
after npm ci; remote CI execution is pending. Defaults, index/check/unique
constraint details, FK deferrability/update policies, triggers/functions and
actual production catalog equivalence remain unproven. This is declared metadata
coverage, not the Django schema-authority takeover gate.

Current committed API revision 8f70339 passes container qualification with
Python 3.12, PostgreSQL 16.15, all five settings cases, database failure/restart
and stale-connection recovery, eleven hierarchy/naming behavior checks and
sanitized logs. Image/fingerprint and fixture-schema hash are recorded in
api-image-qualification.json. Disposable container/network cleanup inventory
is empty. Hosted TLS, architecture, same-origin browser forwarding and Secure
cookie behavior remain pending. The concrete resource creation scope is in
hosted-preview-proposal.md; it awaits authorization and excludes production
routing/data/secrets and existing service replacement.

Committed-source release exporter now materializes the qualified API revision
without reading dirty worktree file contents. Actual export yields 85 allowed
source/config files and matches the recorded API image fingerprint. Railway
configuration is recorded with a separate hash. Five isolated unit tests pass
for allowlist exclusions, fingerprint order/scope, file/manifest output, mismatch
rejection before directory creation, exact revision and symlink rejection. CI
runs both schema-guard and exporter test files. Hosted deployment approval is
still pending; no resources or route ownership changed.

Full-width Generation ORM persistence now passes for image, video and depth on
the current 21-table Drizzle fixture plus hierarchy/naming invariants in disposable
PostgreSQL 16.15, using the production Python 3.12 image. The optional container
harness `--orm-generations` requires runtime + declared schema, verifies its
container DB target before Django setup, inserts the model's 60 columns, reads
back fixture values and rolls back all three rows. It covers exact bigint
values, JSON references/diagnostics, video audio/draft false-vs-null controls,
lineage and depth claim UUID/progress fields. No worker/provider executes.
The initial probe failed before inserts because DJANGO_SETTINGS_MODULE was
missing; explicit production settings corrected the harness. The complete rerun
passes existing health, five settings and eleven invariant cases as well.

Image ID for this run:
sha256:204a439b0fd8894cd76655b88ca5d3d6dbd9017ccefc892bfdecf37a156d74a8.
Revision label f5c8364bffe04fc983844c2725daed0d3a518c2a; API fingerprint remains
730765b8101543f08a4241f8d1706d03a53ec0eee153a62f1354d1447920ff83.
This does not prove enqueue/admission API behavior, provider calls, native MOV
bytes, physical baseline equivalence or production-schema readiness. Hosted
preview authorization remains pending and route ownership is unchanged.

Column metadata guard now also compares single-column uniqueness (including
single-column PK uniqueness). It exposed users.email missing unique=True in
runtime and disk state; corrected with unmanaged authentication 0004. SQL
inspection confirms no application DDL. Guard passes for 21 tables/205 columns,
model drift check passes, authentication regression tests pass, and all eleven
release/schema-guard unit tests pass. Composite/conditional unique indexes,
constraint names, physical null-distinctness and full catalog equivalence remain
separate baseline work. The previously qualified release remains pinned to
8f70339; this new model revision is not silently substituted into that artifact.
No production schema, deployment or route authority changed.

Canvas metadata GET is now IMPLEMENTING in Django. Two isolated API tests pass
for authentication before required-project validation, missing/empty/first
repeated query value, empty unknown-project results, project scope, nullable
createdBy and Unicode names, aged-session renewal and unchanged graph data.
Query capture verifies one metadata SELECT excluding the graph column. Current
Node source is documented in method-specific contract dimensions; POST and
board graph/upload routes remain unimplemented in Django. Actual Node/Django
HTTP comparison, error/header parity, PG16 full-schema/browser/hosted gates and
traffic transfer remain pending. Node retains authority; no routing change.

Real Next/Django HTTP harness now includes eight Canvas metadata cases. The
first run found aged-session renewal missing from Django's projectId-required
400 response; corrected with shared success/error response renewal within the
Canvas view and a regression assertion. Complete local real-server rerun passes:
all eight Canvas cases match status, JSON, selected cookie contract attributes,
metadata graph exclusion and unchanged database snapshots. Existing HTTP
contracts/routing/auth concurrency suite also passes. Two isolated Canvas tests
pass after correction. This run uses development Next/runserver and local PG18
with narrow fixtures, not full-schema PG16, browser or hosted evidence. Invalid
UUID/uncaught-error body parity and complete headers remain pending. Ownership
remains Node; Canvas stays IMPLEMENTING rather than claiming full parity.

Canvas GET is now selectable in the server-only method routing allowlist, with
unset/default routing unchanged and POST retained by Node. A controlled local
Chromium browser run passes settings 200, Canvas metadata 200 and required-project
400 through the real Next-to-Django same-origin proxy. Each response carries a
Django request ID, matches expected JSON and renews the aged HttpOnly/Lax cookie;
response URLs retain the frontend origin. The harness installed Chromium only
in its disposable credential home after the initial missing-browser failure.
Four method-routing unit tests pass. The complete existing HTTP suite plus eight
Canvas cases also pass in this browser run. This is not an Asset Library/full
application browser suite, HTTPS Secure-cookie proof, production Next build,
full-schema PG16 or hosted deployment. No production routing selection or
ownership transfer occurred; authorization for hosted preview remains pending.

History counts GET is now IMPLEMENTING in Django. Three isolated API cases
verify auth, project/global/folder grouping, ignored folder/favorite filters,
audio exclusion/explicit audio, unrecognized depth kind, literal escaped search,
ECMAScript trim and first repeated parameter. Query capture proves four aggregate
queries with a project scope and excludes wide generation payload columns. Eight
real Node/Django HTTP cases pass, including the 200-UTF16-unit split-surrogate
boundary, selected renewal presence and unchanged DB snapshots. The full Django
suite passes 39 discovered tests. This uses local PG18 narrow fixtures and
runserver/Next development servers; full-schema PG16, browser/hosted, complete
error/header parity and performance plans remain pending. No generation enqueue,
worker, provider, schema authority or traffic change occurred.

History count service now passes five full-schema checks in the Python 3.12
production-settings image against disposable PostgreSQL 16.15: grouped global
counts excluding audio, favorite count, explicit audio, literal percent/underscore/
backslash search and a nonmatching wildcard-like string. The probe inserts four
full-width generation rows in a transaction and rolls all rows back; no worker
or provider executes. The complete container harness also passes existing health
failure/recovery, five settings and eleven hierarchy/naming checks. This advances
service/schema compatibility, not full history HTTP parity on PG16 or performance
plans, hosted TLS/browser acceptance, schema baseline or production ownership.

Verified API revision 86154d5c38cf3a79e3d7ea5366e292f8c4fe3f58, API fingerprint
e506cf9f014b1c80c77749b33b9b2c71178478d82de181a8acf3c18114e2c1df,
image sha256:4f7decc13d15a6280d09a2366edb6d37a41cc7f14515bca68a451f7951beefad.
Image inventory has 89 allowed application files and zero unexpected files.
The earlier hosted proposal remains pinned to its separately reviewed candidate;
this new image is not silently substituted. Hosted approval remains pending.

History counts GET is now explicitly selectable in the server method switch.
Unset selection retains Node; the exact GET path is isolated from history feed
and other methods. A real local Chromium run passes its audio-count JSON,
frontend-origin response URL, Django request ID and aged HttpOnly/Lax renewal
through the Next rewrite. Existing settings and Canvas browser cases and the
complete narrow-fixture Node/Django HTTP suite pass in the same run. Five routing
unit tests pass. This controlled document is not full application UI acceptance,
hosted HTTPS/Secure-cookie proof, production Next build or production transfer.
Hosted approval remains pending; route ownership is unchanged.

Public generation serializer is now implemented as a shared Django prerequisite
for history/update reads. Three direct comparisons against current Node rowToItem
pass in the isolated runner: nullable omission vs lineage nulls, false/zero/empty
reference preservation, continuation/first-frame alias, reconciled-vs-estimated
cost basis and structured judge/reference values. Private provider_responses is
excluded in every case. The oracle imports current store-db.js but invokes only
its serializer; no DB, storage, worker or provider function executes. CI now runs
the comparison after npm ci. UUID runtime formatting is handled in Django; this
fixture compares Node wire-shaped values. Full public-field fixture coverage,
actual history/update endpoints, pagination/naming and hosted traffic remain
pending. No route ownership or production artifact changed.

Generation serialization parity now adds an independently generated populated
fixture from all 60 concrete model columns, including actual UUID objects,
true booleans, integer values and structured JSON. This closes the previous
fixture's dependency on the serializer's own field lists: an omitted populated
public field now differs from Node's actual rowToItem output. All four cases
pass, including UUID-to-string formatting; provider diagnostics remain excluded.
Django setup uses the verified runner's disposable settings, but this comparison
executes no database query, storage call, worker or provider request. It remains
serializer evidence, not history/update HTTP qualification or production cutover.

Django update-selection service now implements current readGenerationUpdates:
exclude audio, select queued/running or updated_at strictly greater than since,
order descending updated_at and default cap 100, using the verified public
serializer. Six full-schema PG16 checks pass for old in-flight inclusion, strict
watermark boundary, audio exclusion, private diagnostic omission, descending
order and exact newest-100 selection from 105 distinct timestamps. All inserted
fixture rows are transactionally rolled back. Existing container settings/counts/
invariants/health checks also pass. No HTTP update route, request parser or traffic
selection is introduced yet; actual Node/Django query/HTTP comparison, malformed
watermark semantics, browser/hosted and performance evidence remain pending.

This image is a local working-source qualification: source label aa746ef,
API fingerprint 12ba9e370d6845217991b9d22e02d0b3ced691b153b42f9f4b667285157a839a
captures the new service before its commit; image ID
sha256:83d41cacd450eb5c2b7664e1d0b7c2ba745d3fd768b03bf782674e352c605649.
It is not the committed hosted candidate or a signed attestation. No production,
worker, provider, schema-authority or ownership changes occurred.

Update polling GET is now IMPLEMENTING: compatible authentication, first since
query value, Number-compatible positive finite watermark or five-minute fallback,
public update selection, server now timestamp and session renewal. Forty-four
parser cases match actual JavaScript Number (decimal/radix/Unicode whitespace,
invalid text, overflow/underflow and IEEE rounding). Five generation-app tests
pass, including two endpoint-boundary tests using a mocked selection service;
actual query selection remains separately qualified on full-schema PG16. The
initial fixed-clock renewal test failed due to creating its cookie under a
different clock; consistent fixture creation corrected it. No actual update
HTTP Node/Django parity, fractional/out-of-range PostgreSQL binding comparison,
full browser or hosted qualification is claimed. Node remains traffic owner;
route is not added to the routing allowlist. CI runs the parser oracle.

Update operand qualification found Node's postgres-js bigint comparison rejects
fractional since values (22P02) and oversized integers (22003). Django's normal
IntegerField preparation could truncate or optimize these values. Update query
now uses a parameterized explicit bigint cast, keeping PostgreSQL responsible
for operand validation. Six read-only Node-driver/Django-binding comparisons
pass for valid integers, fractional and scientific-small values, large valid
integer and overflow. CI runs this comparison. Exact driver text formatting for
all extreme doubles and actual HTTP error body/cookie parity remain pending;
this does not prove complete update route parity or authorize traffic selection.
No production database or provider was used.

The corrected complete update query now passes eight checks in the production
Python 3.12 image/full current Drizzle schema on disposable PostgreSQL 16.15.
Added savepoint cases prove fractional since=1.5 raises 22P02 and overflow
since=1e20 raises 22003 even with eligible queued/running rows present; the OR
condition does not bypass operand validation. Original six selection/cap/public
shape checks, five counts checks, three generation-kind roundtrips, settings,
health and invariant checks pass. All fixture rows roll back. Actual update HTTP
Node/Django parity, error bodies/renewal, browser/hosted and production transfer
remain pending. Image revision 8e4fe8d9d6df14b85f1453264770b9514cbaa7e7,
API fingerprint 5d902e9b47f0201a507f5747e1ca7d0e4529e2b0c1299102f432c989d1795983,
image sha256:342532eb8062cd1557641ede6a3f245b58340a1f3c5ddd07b9d19e4c59a28514.
This is local ARM64 evidence, not a hosted deployment or schema authority gate.

Real update polling HTTP comparison now passes nine cases against current Next
and Django, both runserver and production-settings two-worker Gunicorn, on the
verified disposable PostgreSQL 18 loopback cluster. Cases cover anonymous 401,
missing/junk fallback, positive and strict-boundary values, hex/binary input,
future watermark retaining in-flight rows, repeated-query first-value behavior
and aged-session renewal. Returned items match exactly; server now timestamps
are bounded by request start/end rather than compared for equality. Reads leave
fixture snapshots unchanged and exclude audio/provider diagnostics. Existing
settings/auth/project/folder/assets/Canvas/counts and same-origin checks pass.

The local HTTP fixture now adds all currently declared generation column types
from metadata before populating six synthetic rows. It does not recreate all
production constraints/defaults/indexes, prove an old-schema upgrade, or replace
the separately qualified full-schema PG16 container probe. Fractional/overflow
HTTP error bodies/cookies, browser polling, hosted qualification and performance
remain pending. Node owns traffic; updates remain IMPLEMENTING and are absent
from the routing allowlist. No production resources or providers were accessed.

Production-settings Gunicorn HTTP comparison exposed a real error contract
difference: Node sent an empty 500 without Content-Type or renewal for fractional
since=1.5 and overflowing since=1e20, while Django emitted an HTML error page.
Django now handles only database DataError SQLSTATE 22P02/22003 in update
selection, preserving the empty 500 and omitting renewal; other errors propagate.
Logs record only the rejection SQLSTATE, alongside existing structured request
logs. Both actual HTTP error cases now match status/body/content type/cookie
absence with unchanged database snapshots. All nine successful/auth cases and
existing HTTP comparisons pass again. Six generation-app tests pass, including
the new error boundary regression test. No traceback bodies are printed by the
harness. This closes representative fractional/overflow HTTP error qualification;
extreme Number formatting, browser/hosted polling, performance and production
route transfer are still unqualified. Updates remain IMPLEMENTING/Next-owned.

Update polling now has opt-in exact-method routing and controlled Chromium
qualification through the real local Next middleware proxy. Three new browser
cases pass: repeated since values, future watermark retaining in-flight items,
and fractional-operand empty 500. Returned items match the direct Django fixture
response; server watermark is bounded by browser request start/end. Each fetch
remains on the frontend origin and returns Django's request ID. Aged HttpOnly
Lax sessions renew for success, remain unchanged for 500. All seven controlled
browser cases (including settings/Canvas/counts), real HTTP comparisons and six
routing unit tests pass. CI's existing --browser harness includes these cases.

Routing remains unset by default and ownership remains Next/IMPLEMENTING. This
is a minimal controlled fetch document on local HTTP, not full application
polling/store merge acceptance, Secure-cookie HTTPS, Vercel/Railway behavior or
production traffic. Those gates, performance and extreme Number operand text
parity remain pending. No backend route business implementation or user UI was
changed, no deployment performed, and no shared credentials loaded.
