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
