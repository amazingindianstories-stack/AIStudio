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
