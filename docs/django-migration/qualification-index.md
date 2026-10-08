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
