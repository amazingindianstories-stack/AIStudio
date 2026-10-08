# Cutover gates

No production operation is authorized by local qualification alone. Before any
shared-target command, verify its actual target and obtain the documented
production authorization. The attached isolation requirement prohibits using
shared credentials for tests, workers, migrations or development commands.

1. Reconcile current worktree and deployed revision; preserve completed UI work.
2. Qualify isolated PostgreSQL 16 foundation, behavioral contracts and browser.
3. Prepare early Railway API service with explicit secrets, DB target, health,
   logs and same-origin method routing; review before deployment.
4. For each domain: parity, preview, authorized production canary, observation,
   authoritative transfer, rollback-window close, remove Node method.
5. Before schema takeover: fresh Django-only schema equivalence, actual catalog
   review, backup/PITR, safe migration-history baseline and verification.
6. Only after full Django HTTP API authority: split worker boundaries and qualify
   export then provider-by-provider generation workers with shadow/canaries.
7. Remove retired Node DB/provider dependencies and backend Vercel credentials.

Schema-changing final releases: backup/PITR, migration preflight, Django migration,
schema verification, API deployment, worker deployment, frontend deployment,
smoke checks and release verification. Migration failure blocks promotion.

All live evidence, release identities, rollback checks and secret-removal evidence
remain pending. See status.md and the original source-request.txt acceptance list.

## Method routing prepared

Server-only `DJANGO_API_METHODS` selects comma-separated `METHOD /api/path` keys;
currently only `GET /api/settings` is implemented in the routing allowlist.
`DJANGO_API_ORIGIN` must be a bare HTTPS origin. Explicit local qualification
uses `DJANGO_API_ALLOW_LOCAL=1` with loopback HTTP. No browser API-base change.
Unset method selection retains current routing. Invalid selected configuration
fails closed with 503; it cannot silently execute the rollback Node owner.
Production setting changes still require authorization and ownership evidence.

Local real-server qualification proves the frontend-origin settings request
reaches Django via Next rewrite, matching JSON and carrying Django request ID.
Hosted forwarding, production cookies, browser and preview checks remain pending.

## Railway service configuration review

Prepare a separate API service using backend/railway.toml, without modifying
root worker configuration. Required explicit values: DJANGO_SECRET_KEY,
AUTH_SECRET (compatible during staged auth transfer), DATABASE_URL and a finite
DJANGO_ALLOWED_HOSTS allowlist. No checkout dotenv files enter the container.
Database URL libpq TLS options are preserved; unknown options block startup.
Review sslmode and CA configuration against the actual database transport before
deployment. Do not assume the existing Cloud SQL Node connector configuration
translates directly into a PostgreSQL URL from Railway.
The concrete service release inputs and evidence checklist are in
railway-api-release.md. The API Dockerfile has a dedicated build-context
allowlist; use the reviewed committed source rather than uploading this dirty
checkout. Local ARM64 container qualification now passes; see api-image-qualification.json.
Hosted Railway/TLS qualification remains pending.

Request logs emit sanitized JSON to stdout with request ID, matched route,
status and duration; query strings and cookies are excluded. Gunicorn raw access
logging is disabled because future media-grant queries can contain credentials.
Secure renewal cookies have isolated API-test coverage. Hosted TLS, proxy host
behavior, service connectivity and deployment health remain unverified.

## Browser mutation protection

Django rejects unsafe /api requests carrying an Origin outside the exact
`DJANGO_BROWSER_ORIGINS` allowlist, including null origins. Without Origin,
cross-site/same-site Fetch Metadata is rejected. Origin-less machine clients
remain subject to endpoint authentication. Production requires explicit bare
HTTPS frontend origins; no wildcard, credentials, path or query is accepted.
This is a deliberate security correction; current Node lacks this middleware.
Before selecting mutations, prove actual browser requests through the hosted
same-origin proxy retain Origin and use the configured public frontend origin.
Do not trust forwarded Host as an origin allowlist or enable broad CORS.
