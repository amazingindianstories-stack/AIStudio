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
