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
