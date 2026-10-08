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
