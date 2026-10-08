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

Expanded actual Node-driver operand qualification from six to 17 numeric cases.
It exposed scientific notation differences at 1e21 and above: Node/PostgreSQL
rejects text as 22P02 while exact Python integer expansion produced 22003.
Django binding now retains scientific notation at that boundary. It also expands
shortest float text for integral values below 1e21 instead of converting the exact
binary integer; this preserves the rounded decimal operand near bigint limits.
The oracle now compares PostgreSQL's actual accepted bigint text, as well as
comparison results and error SQLSTATE, so a constant Boolean cannot hide a
different valid bound integer. All 17 cases pass, including finite maximum,
subnormal minimum, exponent boundaries, fractional inputs, bigint edge rounding
and integer overflow; six generation tests pass. CI uses the expanded oracle.
This finite corpus does not prove Number-to-text identity for every IEEE double;
full browser application, hosted/performance and production ownership gates
remain pending. No shared database, provider or deployment was used.

Main history read preparation adds cursor and page-limit parsing from the actual
current route/store decoder. Forty-one cases match Node: malformed cursor resets,
first-dot splitting, UUID text/case validation, finite signed/radix/exponent sort
values, decimal-prefix parseInt behavior, Unicode whitespace, clamp 1..100 and
default 20 including overflow. The oracle imports the actual Node decodeCursor
without executing database queries and runs in CI. Shared Number parsing is
extracted from watermark parsing; all existing 44 watermark oracle cases pass.
No history HTTP endpoint or traffic selection is introduced by this prerequisite.
History requires composite PostgreSQL keysets, favorites ordering, lookahead,
filter semantics and canonical filename resolution; these must be implemented
and qualified together before claiming the route. History status/ownership
remains unchanged. No shared credentials or production resources were used.

Canonical filename preparation adds the Python pure formatter from the current
filename-resolver.js semantics: NFKD ASCII folder slugs, R/SC tokens, reserved
Windows names, serial padding, MIME/key/URL extension precedence, and bounded
255-byte names with the current SHA256 hash suffix. Forty-five cases match the
actual Node resolver, including nested folders, no ancestry, project/global
unsorted, long paths, Unicode, MOV masters versus MP4 previews and sequence
boundaries. The pure oracle executes no database/storage/provider calls and is
added to CI. No output bytes are transformed or formats substituted.

This is filename formatting evidence, not complete batch naming/history/export
qualification. Database ancestry lookup, persisted generation_naming namespace
and sequence, missing-record fallbacks, batch independence and moves/renames
still require implementation/comparison. History remains unimplemented and
traffic ownership unchanged; no deployed schema or shared resources were used.

Batched Python database filename resolution now reads requested generation IDs
with a left join to generation_naming, then fetches only referenced folder
ancestors in batches with cycle protection. Persisted namespace/sequence wins;
legacy absent naming records use current folder/project/global namespace and
sequence 1. Results preserve generationId/filename/namespace/sequence/extension.
No sequence is allocated and no naming data is mutated by this read service.
The current Node resolver also fetches project names that its pure formatter
ignores; Python omits that unused lookup without changing the public result.

Six batch comparisons against the actual Node resolver pass on disposable local
PG18, covering empty/duplicate/reordered/missing IDs, persisted versus legacy
records and nested folder ancestry. Independent expected names verify root
serial 12, root/child fallback serial 1 and global persisted serial 42. Snapshots
include generation_naming and remain unchanged. Existing real HTTP comparisons
pass. This uses narrow qualification fixtures, not full-schema PG16 naming
invariant/rename/move/concurrency acceptance. History HTTP integration and those
gates remain pending; no ownership, schema authority or deployment changes.

GET history is now IMPLEMENTING in Django: active-session authentication, current
project/folder/kind/favorite/literal-search filters, parsed page limit/cursor,
created_at or favorited_at plus descending UUID ordering, strict composite
PostgreSQL row comparison, limit+1 lookahead, explicit nextCursor, public
generation serialization and canonical database filename resolution. No
PATCH/DELETE history behavior is introduced. The route is absent from the
routing allowlist and Next remains its traffic owner.

Ten real Node/Django HTTP comparisons pass on disposable local PG18 fixtures:
anonymous 401, defaults, aged renewal/page size, equal-timestamp UUID cursor,
project/global/folder-none filtering, explicit audio, favorite pagination, junk
cursor and decimal-prefix limit, literal wildcard/backslash search. Status/JSON
(including filename and nextCursor), renewal presence and unchanged database
snapshots match. Existing HTTP and batch naming checks pass. Narrow fixtures
do not establish full-schema PG16/production performance, concurrent insert
pagination, populated favorite timestamp ordering, malformed UUID/operand errors
or full application/browser/hosted acceptance; those gates remain pending.
No production deployment, provider/storage call or schema authority change.

History pagination HTTP qualification now includes production-settings two-worker
Gunicorn. Populated favorite timestamps prove star-time ordering and a two-row
exact page-size multiple ends with nextCursor=null. A controlled newer insert
committed between first and subsequent reads proves the strict composite cursor
returns all five original non-audio rows exactly once across three pages,
excluding the newer insert. Each request matches Node/Django JSON and leaves
snapshots unchanged; intentional fixture mutations are confined to disposable
PG18 and cleaned afterward. Existing ten history cases and all prior HTTP
comparisons pass. The machine-readable GET history contract now records query,
ordering, lookahead, naming, effects, evidence and remaining gates separately
from PATCH/DELETE. This is sequential inter-request insertion evidence, not a
concurrent stress test or full-schema/index-plan acceptance. Browser/hosted,
performance, error parity and production ownership remain pending.

History failure qualification found the same framework body mismatch previously
fixed for update polling: malformed projectId/folderId and fractional/overflow
cursor sort values returned empty 500 on Node but HTML on Django. History now
handles UUID validation code invalid and database DataError SQLSTATE 22P02/22003
with the current empty 500, no Content-Type and no renewed cookie. Other
validation/database errors propagate. Logs include only a rejection category or
SQLSTATE, never supplied query text or database error details. Four actual HTTP
cases now match under production-settings two-worker Gunicorn with unchanged
fixture snapshots. All ten successful/auth history comparisons, both keyset
scenarios and prior HTTP checks pass again. This finite corpus does not qualify
all PostgreSQL UUID spellings or extreme cursor values. Full-schema PG16,
performance, browser/hosted and production transfer remain pending.

GET history now has an exact, opt-in same-origin routing switch. Three controlled
Chromium cases pass through the real local Next proxy: page limit 1 with public
fields/canonical filename, strict cursor yielding the empty terminal page, and
invalid project empty 500. Results equal the direct Django responses and carry
Django request IDs while response URLs stay on the frontend origin. Aged
HttpOnly/Lax cookies renew on successful reads, not failure. All ten controlled
browser cases and existing HTTP/keyset/batch-naming checks pass; seven routing
tests verify opt-in exact paths and retained PATCH/DELETE ownership. Existing CI
--browser execution includes these cases.
This minimal controlled local HTTP document does not prove Asset Library UI
scroll/merge acceptance, HTTPS Secure cookies or hosted Vercel/Railway behavior.
History remains IMPLEMENTING with Next production ownership; routing is unset
by default. Full-schema PG16, performance and deployment gates remain pending.

Full current declared schema + additive hierarchy/naming SQL on disposable
PostgreSQL 16.15 now passes eight history-service checks inside the production
Python 3.12 image: UUID timestamp tie ordering, strict composite cursor, newer
insert exclusion, exact-multiple terminal cursor, persisted canonical names,
favorite timestamp keysets, explicit audio filter and private diagnostic
omission. Naming fixtures are explicitly inserted; an initial failed fixture
incorrectly assumed ORM insertion allocated generation_naming automatically.
That assumption was corrected without changing production allocation semantics.
All generation fixture rows roll back. Existing three generation-kind roundtrips,
five counts/eight update checks, settings, health recovery and eleven hierarchy/
naming behavior cases pass. CI's existing container probe includes these cases.

Image source fd8ea7e62beacf2208fa2ca760629c62815efb59, API fingerprint
c2051d16f8608e4238cca149c8f7d3ec515ba4f65ede9c4c7987318c788b5dd9, image
sha256:e8e226a8433bfad19c531757305be3a3d54efdd3f496cb3e55fbd5912bd679c8.
This local ARM64 image evidence is not hosted deployment, production-catalog
equivalence, old-schema upgrade or complete invariant acceptance. Performance,
full application, hosted and production transfer gates remain pending. No shared
credentials, provider requests or output-media transformations were used.

Regression checkpoint after the history integration: all 42 existing Django
domain-suite tests pass on the verified disposable loopback PG18 configuration;
makemigrations --check reports no changes. Current declared column/type/null/
unique/PK/FK metadata matches 21 tables/205 columns in runtime and disk migration
state. This does not establish physical defaults/indexes/functions/triggers or
production catalog equivalence. Existing domain-suite tests do not exercise
history query integration; the separate HTTP/Chromium/full-schema PG16 service
evidence above covers that scope. regression-checkpoint.json records this
boundary and the remaining gates against source a55419d. Ownership remains
0/85 Django traffic, 12 methods started; no deployment or provider activity.

History database query scaling now has a full-schema PG16 regression probe:
100 synthetic generations share a three-level folder chain and explicit persisted
naming records. Page sizes 1,20,100 each execute exactly five SELECTs (history,
joined naming inputs, three ancestor levels). The execution wrapper rejects any
non-SELECT statement during the measured read. Every returned filename retains
the R1_R2_R3 path. Query count is independent of page size for this fixture,
preventing per-item ancestry/naming reads. Fixture generations/folders/naming
records live in the rollback transaction. CI's existing image probe includes it.

Observed single local samples were 2.876/3.426/6.935ms for page sizes 1/20/100,
excluding authentication/network. These are diagnostic samples, not a production
SLA, statistical benchmark, Node baseline or representative large-table plan.
Broader query plans/cardinalities/depths/concurrency/HTTP baselines remain
unqualified. All previous full-schema/history/count/update/settings/health and
invariant checks pass. Source ccda75650108fa38b4598c5740d9cfbd0ca02001, API
fingerprint c2051d16f8608e4238cca149c8f7d3ec515ba4f65ede9c4c7987318c788b5dd9,
local image sha256:cfd7210d4f809bc86b821382b0d055117a6ac0903438ffd513d8a7403bde8b0e.
No hosted deployment or production ownership/schema authority change occurred.

History plan instrumentation captures the first SELECT emitted by the real
query_history service, then runs EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) with its
original bindings only on disposable PG16.15. Five thousand additional bulk
fixture generations enlarge the three-level folder dataset to 5,100; ANALYZE
runs only in this disposable container. Printed plan summaries omit SQL, query
parameters, filter expressions and media fields. All fixture writes roll back.

Observed common-search/folder plans use generations_created_at_idx plus
incremental sort; the folder cursor has an index condition. Single database-only
execution samples were 0.056/0.027/0.035ms. A no-match substring search instead
uses sequential scan plus sort, rejects all 5,223 rows in the database and takes
5.281ms. This records an unresolved search-scaling risk, not performance parity
or a production SLA. Node comparative plans, representative distributions,
rare matches, bigger cardinalities and concurrency remain required. No planner
node/index choice is forced by the probe and no schema/index change was made.
All previous container checks pass. Source 5794c022f4d78c821b4d529c998cfc54a6362e9f,
API fingerprint c2051d16f8608e4238cca149c8f7d3ec515ba4f65ede9c4c7987318c788b5dd9,
image sha256:f6ed625c574416014aa713bcca767e2ddc24ee3e5787bfc8f1fb789e1747da5d.
This remains local ARM64 evidence; hosted and production transfer are pending.

Actual Node/Django history plan comparison tooling now runs with the HTTP
harness. The Node oracle instruments the current Drizzle session logger while
calling actual queryHistory, capturing its first SELECT and bindings, then
executes EXPLAIN ANALYZE through the same isolated postgres-js client. Django
uses an execution wrapper on actual query_history. No Node business source is
modified and no manually reconstructed query substitutes for either service.
Printed results contain only plan node types/counts/index names/timing and
response-equality flags; SQL and bindings are not printed.

Four cases pass exact response comparison on the six-row disposable PG18
fixture: literal wildcard/backslash search, no-match search, folder filter and
UUID composite cursor. Both implementations choose Limit/Sort/Seq Scan for
these small fixtures. All existing HTTP checks pass. This validates the real
query comparison mechanism, not larger-cardinality performance parity. The
previous PG16 5,100-row no-match scaling concern remains unresolved until Node
is compared on equivalent larger/indexed data. These local timings are neither
representative nor thresholds. The main HTTP CI harness includes this tooling;
Drizzle session instrumentation may require adjustment when dependencies change.
Production ownership, schema authority and hosted authorization remain unchanged.

Actual Node/Django history comparison now adds 5,000 synthetic generations to
the same verified disposable PG18 HTTP fixture database, analyzes its local
statistics and compares seven actual service responses/plans. Additional cases
cover matching/no-match large prompt searches and a folder cursor midway through
the synthetic timestamps. All seven responses match; existing HTTP regressions
also pass. Synthetic IDs are explicitly tracked and deleted in finally; the
parent harness confirms its original full fixture snapshot is restored.

This narrow physical schema has no declared history indexes, so observed full
scans are also present in the actual Node query (the literal search scans the
5,006-row fixture and discards 5,005 rows). It establishes that this scan is not
unique to Django on this fixture. It does not resolve the separate full-indexed
PG16 search-scaling concern or prove production performance parity. Node/Django
comparison against equivalent full indexed schema, representative distributions
and concurrency remains necessary. No production database, deployment, index
change or schema authority transfer occurred. CI's HTTP harness includes the
larger comparison and fixture cleanup guard.

Actual Node/Django comparison now installs all 12 currently declared generation
indexes from getTableConfig metadata into the disposable PG18 fixture database.
The metadata emitter preserves column order/direction/null ordering, uniqueness,
method and unparameterized partial predicates; unsupported expressions/opclasses
fail rather than silently approximating. It imports schema metadata only and
creates no connection. No production schema or migration authority is changed.

Seven response comparisons pass again on the same 5,006 rows and declared
indexes, with identical observed plan node/row/index structures. Common folder
and matching-search cases use generations_created_at_idx/incremental sort;
one cursor uses generations_created_keyset_idx. Rare literal and no-match
searches use Seq Scan/Sort in both implementations. The large no-match case
rejects 5,006 rows in both; single DB-only samples were Node 1.699ms and Django
1.702ms. This establishes a shared scan pattern for this dataset rather than
a Django-specific regression. It does not prove a production SLA, all physical
constraints/defaults/triggers, full PG16 driver parity, larger distributions,
concurrent behavior or HTTP latency. Those performance/hosted/application gates
remain pending. Fixture cleanup restored row snapshots and all HTTP checks pass.
Indexes persist only in the dedicated disposable qualification database.

Local HTTPS browser qualification now closes the previous production Secure
cookie harness gap. A qualification-only TLS front door binds 127.0.0.1,
forwards GETs to the real Next proxy, preserves response/cookie headers and
uses ephemeral one-day certificates/keys under isolated TMPDIR. It installs no
trust roots and prints no keys. Chromium ignores certificate validation only
inside this loopback test context; input hostname/protocol are asserted. TLS
server and certificate directory close/clean up on exit.

All ten controlled browser cases pass with production-settings two-worker
Gunicorn: settings, history pages/cursor/error, update polling/error, counts and
Canvas 400/200. Browser cookies are explicitly asserted Secure, HttpOnly and
SameSite=Lax; successful aged sessions renew, both 500s retain the prior cookie.
Fetches remain on the frontend HTTPS origin and carry Django request IDs.
Existing actual Node/Django HTTP and indexed plan comparisons also pass. CI
now runs --gunicorn --browser alongside the existing local HTTP browser pass.
This is ephemeral loopback TLS with a test certificate, not hosted certificate
validation, Vercel/Railway forwarding or full application acceptance. Those
gates and production transfer remain pending. No shared credentials/providers
or production resources were used.

HTTPS Secure-cookie renewal qualification now checks actual follow-up browser
transport. After each of the eight renewal cases, Chromium performs another
settings fetch without cookie reinjection/reset. All eight follow-ups return
authenticated expected JSON with Django request IDs on the same HTTPS origin.
The fresh cookie remains unchanged (no renewal on every request), and
document.cookie cannot expose the HttpOnly session. Both failure cases keep
the aged cookie and skip this fresh-cookie follow-up; report null denotes not
run, not rejection. All ten base browser cases plus existing HTTP/plan checks
pass with production Gunicorn settings. Existing CI HTTPS browser execution
includes the added assertions.
This strengthens local browser transport evidence; hosted TLS/proxy behavior,
full application flows and production domain transfer remain unqualified. No
shared credentials, provider calls or production deployment occurred.

Django generation model/migration state now preserves ten current index
declarations and original PostgreSQL names, including names beyond Django's
portable 30-character limit. A PostgreSQLIndex subclass permits 63 characters;
system checks pass. SeparateDatabaseAndState migration 0002 has empty database
operations; sqlmigrate confirms no-op DDL and makemigrations reports no changes.
A CI guard compares index inventory, column order/direction and simple boolean
partial predicates against current Drizzle metadata in runtime and disk state;
all ten match. An initial comparison needed normalization of Django's implicit
ascending direction. It does not compare physical catalogs or all index options.
Two complex worker indexes remain unmodeled. Generation stays unmanaged and
Drizzle remains schema authority; no physical schema change or deployment.

Generation state now includes the two compound worker indexes in state-only
migration 0003. The comparison guard preserves internal predicate grouping and
SQL literal whitespace, checking all twelve declarations in runtime and disk
state against current Drizzle metadata. All twelve match. The literal percent
in the Magnific LIKE condition requires Django formatting escape (`%%`); the
compiled predicate retains the original single percent. System checks and
makemigrations pass; sqlmigrate 0003 emits only a no-op transaction. Physical
indexes, worker ownership and schema authority remain unchanged.

The generation declaration comparison now also checks NULL ordering in compiled
CREATE INDEX SQL. The previous field shorthand used PostgreSQL DESC NULLS FIRST,
whereas current Drizzle declares DESC NULLS LAST. State-only migration 0004
replaces five keyset index declarations with explicit OrderBy expressions; it
emits no physical DDL. All twelve declarations now match including NULL ordering.
A CI probe creates indexes on transactional temporary tables for both runtime
and disk state, then reads pg_index ordering flags: 24 checks pass. Two negative
controls reproduce and reject the previous DESC NULLS FIRST behavior. All
temporary objects are rolled back and verified absent. This proves exercised
index column ordering, not full physical catalog equivalence, defaults, unique
constraints or baseline readiness. Production schema and ownership are unchanged.

All current Drizzle-declared indexes are now represented in Django runtime and
disk state: 33 across the 21-table inventory. The remaining declarations include
folder partial uniqueness, generation namespace/sequence uniqueness, export
ordering and due-work indexes, organizational idempotency, agents, assets, login
attempts and activity logs. PostgreSQLUniqueIndex preserves a unique index's
catalog object form rather than replacing it with an unconditional unique
constraint. Seven new migrations use empty database operations; sqlmigrate
confirms each emits no physical DDL. Existing Canvas and portrait-group indexes
were present at runtime but missing from initial unmanaged migration state;
explicit state operations correct that gap.

The new CI index-state guard compares inventory, uniqueness, columns, direction,
NULL ordering and predicates against current metadata. The physical temporary
table probe verifies 66 indexes across runtime/disk states, including catalog
uniqueness and partial-index presence. Twenty-four insert checks exercise folder
root/child collision scopes and namespace/sequence collisions, including allowed
different scopes/sequences. All temporary objects are rolled back and verified
absent. The 42 Django regression tests, 205-column guard, system checks and
makemigrations consistency pass. This is declared-index preparation and isolated
behavior evidence, not production catalog equivalence: migration-script-only
objects, defaults, constraints, functions, triggers and Django-only baseline
reproduction still require the takeover gate. Drizzle remains schema authority;
no runtime, provider, worker or production traffic ownership transferred.

Django runtime/disk state now declares the current positive generation-naming
sequence check and the folder-color check from the current additive migration
source. Library migration 0005 has empty database operations; sqlmigrate confirms
no physical DDL. A CI probe derives the sequence condition from Drizzle metadata
and reads the color migration as text without importing its dotenv/DB entrypoint.
On rolled-back temporary PostgreSQL tables, source SQL and both Django states
produce identical canonical constraint definitions and validation/deferrability
flags (four comparisons). Fifty-seven insert checks cover all eight colors, null,
invalid/blank/case/whitespace variants, nonpositive sequences, positive sequences
and bigint maximum. Null sequence passes the CHECK alone; the existing column
nullability guard remains responsible for its NOT NULL declaration. All objects
are rolled back and verified absent. Django system checks, migration consistency
and 42 regression tests pass. Local verification uses disposable PostgreSQL 18;
CI runs the probe on its PostgreSQL 16 service. This does not prove deferred scope
triggers, physical NOT NULL/FK/default equivalence or production baseline readiness.
No schema authority or production ownership changed.

All 46 current Drizzle database defaults now have Django `db_default` declarations
in runtime and disk migration state. They include fourteen gen_random_uuid()
fallbacks, literal text/numeric/boolean defaults and two JSON array defaults.
Existing Python-side defaults are preserved. Ten migrations use empty database
operations; sqlmigrate confirms no physical DDL. The CI default probe imports
schema metadata only and rejects unsupported SQL/runtime default forms.

Disposable temporary tables compare PostgreSQL's canonical default expressions
for all 205 columns in both Django states: 410 comparisons pass, including absent
defaults. Source/runtime/disk SQL inserts verify 573 literal/absent values and 42
UUID-v4 fallbacks. Actual Django ORM omitted-field inserts verify all 46 defaults
in both registries (92 checks). Raw cursor JSON values require JSON decoding
before comparing with fixture arrays; ORM JSON values are already decoded. All
temporary objects are rolled back and verified absent. System checks, migration
consistency and 42 Django regression tests pass. Local PostgreSQL is version 18;
CI's configured PostgreSQL 16 service runs this qualification.

This is declared-default equivalence, not a complete Django-only schema baseline
or production-catalog comparison. Temporary default tables intentionally omit
NOT NULL/FK/index/trigger rules to isolate defaults; those require their own
physical qualification. Current migration-script-only defaults and unexpected
production objects remain subject to the baseline gate. Drizzle and runtime
ownership remain unchanged; no production DDL or traffic transfer occurred.

The real Node vs Django HTTP harness also passes after these declarations using
two Gunicorn workers and production Django settings on the isolated local DB.
It exercises the implemented read contracts, auth login/logout/password and
mixed-runtime default-project/password seams, history pagination/errors and
seven 5,006-row history response/plan comparisons. This run does not execute the
browser option or prove hosted traffic readiness. The 21-table/205-column/PK/FK
guard continues to pass. No shared/provider credentials were loaded.

Whole-schema reproduction diagnostic now exists in
`scripts/django-migration/schema-reproduction-probe.py`. It builds a fresh current
Drizzle fixture plus current hierarchy/naming SQL and color check, then a fresh
fixture materialized from disk Django migration model state. Both use the same
scratch namespace in separate rolled-back transactions. No public application
DDL is applied. This is not yet a Django-migrations-only baseline.

The current local PostgreSQL 18 comparison is **not equivalent**. Both fixtures
have 21 tables/205 columns. Five categories differ: columns, constraints, indexes,
functions and triggers. The 79 differing column rows differ only in physical
ordinal position; types/nullability/defaults match. The current fixture has 58
indexes versus Django's 72: implicit FK and text pattern indexes add objects, and
unique/composite-PK names differ. Current SQL FKs preserve immediate RESTRICT or
CASCADE; Django schema_editor generates deferred FKs without those SQL deletion
clauses. Django's on_delete service policy does not prove physical FK equivalence.
Current additive scripts also yield duplicate named FK constraints in this
fresh-fixture path; actual production presence must be audited before any
preserve/exclude decision. Four custom functions/five triggers are missing from
Django reproduction. PostgreSQL 18 NOT NULL catalog constraints are version
specific; PostgreSQL 16 comparison is still required.

The detailed synthetic fixture report is `schema-reproduction-gaps.json`. No
automatic normalization or waiver hides these differences. Diagnostic mode exits
successfully after capturing evidence; `--require-equivalent` deliberately exits
1 for this incomplete state. Both modes verify scratch-schema rollback. This
report is a baseline blocker, not schema takeover approval or production proof.
Next baseline work must represent exact physical FK behavior and names, remove
unintended indexes, preserve/check physical column order, and port current
functions/triggers into Django migration SQL before testing an empty Django-only
baseline and reviewing the real production catalog. Authority remains Drizzle.

The current reproduction report now reflects explicit `db_index=False` on all
seven relationship fields. This removes six unintended foreign-key indexes from
a fresh Django fixture (the one-to-one PK had no redundant index). Four new
state-only migrations emit no DDL; the index-state guard verifies this alongside
the seven earlier index-state migrations. It also rejects automatic FK index
flags in runtime and disk state. All 33 explicitly declared indexes and all
205 columns/PK/FK policies still match; system checks, migration consistency
and 42 regression tests pass. Full physical reproduction now has 66 indexes
versus the current fixture's 58, down from the initial Django count of 72.
Eight unintended text pattern indexes remain, alongside unique/composite-key
naming differences, physical FK clauses/deferrability, column order and missing
functions/triggers. Five catalog categories still differ. The refreshed report
does not prove equivalence or authorize physical production index removal.
Existing database objects and Drizzle authority remain unchanged.

The PostgreSQL backend now uses a scoped schema-editor override for the eight
current text PK/unique columns without text_pattern_ops indexes. It suppresses
only automatic LIKE indexes for those exact table/column pairs; unrelated tables
retain Django's default behavior. No field types, uniqueness rules, query
execution or existing physical indexes change. Explicit future pattern indexes
remain available through reviewed index migrations. A CI probe verifies sixteen
runtime/disk suppression cases and creates an unrelated temporary control index
with text_pattern_ops, then verifies rollback. System checks, migration-state
consistency and 42 Django tests pass.

Fresh disk-state reproduction now has 58 indexes, matching the current fixture's
count, down from 66. Counts alone do not establish equivalence: six PK/unique
index names still differ, and five catalog categories remain unequal, including
physical FK clauses, column order and missing functions/triggers. The detailed
report is refreshed. This schema-editor preparation does not transfer schema
authority or create/drop production objects. PostgreSQL 16 and complete
Django-migrations-only baseline qualification remain required.
