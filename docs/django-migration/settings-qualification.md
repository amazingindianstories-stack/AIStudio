# Settings qualification — 2026-10-07

Command: isolated.py run SESSION VENV/bin/python
scripts/django-migration/settings-http-parity.py. SESSION is the independently
created local PostgreSQL cluster verified by the isolation runner. No shared
credentials or dotenv files are inherited. Current Next dev server and Django
runserver execute the actual route handlers; HTTP requests use loopback.

Seven scenarios passed: anonymous 401, invalid signature 401, authenticated
defaults 200, auth-version mismatch 401, aged-session renewal 200, invalid
personal override/default and clamp 200, disabled user 401. Each comparison
requires equal status and JSON, JSON content type, matching renewal presence,
HttpOnly/Lax/path flags, and unchanged snapshots of users/settings/user_limits.

Separately six Django API tests pass, including 17 parser cases compared with
current src/lib/limits.js. No storage or provider integration is invoked.

Limits: local PostgreSQL 18, minimal fixture schema, dev HTTP servers. Production
Secure cookies, comprehensive header
parity, concurrency/performance, PostgreSQL 16 CI and browser/deployed preview
remain unqualified. This evidence does not establish production readiness or
schema equivalence. Next remains the traffic and session issuer owner.

Renewal interoperability extension passed: each runtime accepts each issuer's
renewed cookie (four real follow-up HTTP requests), returns the same limits, and
does not immediately renew again. Both max-age values are 2592000 seconds.
CI now installs Node dependencies and runs this real HTTP harness using the
dedicated PostgreSQL 16 service. Remote CI execution is still pending.

Local Chromium contract passes: a controlled same-origin document performs
fetch('/api/settings') through the real Next middleware rewrite, sees matching
limits and Django request ID, and receives a replaced HttpOnly/Lax renewal
cookie. Browser was installed under the disposable HOME; no personal profile
is used. This proves the tested browser transport, not the Asset Library UI,
HTTPS hosted forwarding, Secure-cookie behavior or the full existing suite.
The PostgreSQL 16 CI job now runs this browser contract; remote CI is pending.

## Bounded settings reads — 2026-10-08

Django now filters both global settings and personal overrides to the two
registered response keys. Qualification inserts 2,000 unrelated rows into each
table and verifies the correct effective limits with exactly three database
queries (session user, globals, overrides). Both settings queries restrict the
keys in SQL, so unrelated settings are not materialized in Python. All six
admin-dashboard tests passed through the verified disposable runner, followed
by the complete Node/Django HTTP harness under two-worker production-settings
Gunicorn, including the same-origin rewrite. This establishes a bounded query
shape; it does not establish hosted latency, production query plans or a
Node-versus-Django load baseline. No schema or traffic ownership changed.

## Production image and PostgreSQL 16 — 2026-10-08

The isolated runner's `container-build.py --runtime` now exercises the actual
API image's default production Gunicorn startup against a newly created
internal-only PostgreSQL 16.15 container with tmpfs data. Actual image/network/
mount categories are verified before database commands. Five settings scenarios
pass: defaults, global/personal overrides, invalid personal fallback plus clamp,
auth-version mismatch and disabled user. Each uses a synthetic aged session;
successful reads issue Secure/HttpOnly/Lax/path/max-age-compatible renewal cookies
and a follow-up request accepts the renewed token without immediate renewal.
Users/settings/user_limits JSON snapshots are unchanged by every read/follow-up.

This uses a minimal three-table fixture, manually supplied cookies over container
loopback HTTP, and the current Django image. It is not Node/Django comparison
inside containers, full-schema integration, schema baselining, browser Secure
cookie transport, hosted preview or production acceptance. The Node/Django
comparison remains the separate real-server harness. No service or ownership
was transferred. Readiness/outage/recovery checks also passed in the same run.

## Complete declared table set — 2026-10-08

`container-build.py --runtime --declared-schema` passes the same five settings
contracts, secure renewal/follow-up and unchanged DB snapshots against all 21
tables generated from the current `src/lib/schema.js`. Drizzle generate runs
only inside the verified clean copy, writes SQL into a disposable directory,
and that SQL is applied only to the newly created tmpfs PostgreSQL 16.15
container. The actual public base-table count is asserted to be 21. The users
fixture supplies the declared required password and creation fields; no partial
users/settings/user_limits DDL is used in this variant.

This establishes settings runtime compatibility with the current declared
schema shape. It is fresh-schema setup, not old-schema upgrade coverage or
production equivalence. Additional invariants implemented by migration scripts
(functions, triggers and advanced constraints) are not installed by this step.
Django-only schema creation, complete ORM coverage and exact catalog equivalence
remain pending. Drizzle remains the recorded schema authority.

## Hierarchy/naming SQL installation evidence

`--invariants` additionally reads the current migration modules' exported SQL
arrays without running their DB entrypoints. The verified isolated copy contains
no checkout dotenv credentials. Statements are applied inside transactions to
the new tmpfs container, twice per domain: hierarchy 38, naming 17. One complete
run passed with four public functions and five non-internal triggers present,
followed by all five settings contracts. This does not prove trigger behavior,
equivalence or upgrade coverage, nor install every migration script's invariants.

An initial attempt failed in the settings probe subprocess; its stderr was not
reported by the original harness, and its cause remains unresolved. Improved
synthetic-container diagnostics are committed. The later pass establishes
successful installation/execution evidence, not repeatable readiness acceptance.
Investigate the initial failure before treating this variant as a stable gate.

## Persistent-connection recovery correction

A strengthened run warmed Gunicorn connections with twelve health requests.
After DB restart and an initial recovered 200, a later worker request returned
503/database-unavailable. This reproduces stale per-worker connections after
restart; the exact earlier settings subprocess failure still lacks its original
diagnostic. Django now enables `CONN_HEALTH_CHECKS` for the existing 60-second
persistent connections, as described in
https://docs.djangoproject.com/en/5.2/ref/databases/#persistent-connections.

The strengthened container variant passes after this correction with
`--runtime --declared-schema --invariants --connection-recovery`: warmed workers,
DB outage/restart, twelve subsequent healthy probes, then explicit termination
of only this disposable database's connections followed immediately by settings
and renewal requests. No settings retry masks errors. All five cases and DB
snapshots pass. This verifies the exercised connection-reuse correction, not
arbitrary outage/load resilience or broader cutover readiness.
