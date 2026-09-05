# Django Railway cutover

Release preparation status: **stop before production launch**. The signed evidence
record is `docs/cutover-go-no-go.md`. Production work cannot begin before the
AWS/GCS gate closes on 2026-09-10 and every final inventory check passes.

The Django service is the target API and schema authority. Vercel serves the
Vite React SPA as static assets only. The prior Next.js API source is retained
unchanged for the seven-day rollback window; do not delete it or the Drizzle
tooling until the observation gate passes.

## Ownership and credentials

- Platform owner: Amazing Indian Stories infrastructure administrator.
- Application owner: Lumina Studio backend maintainer.
- Use one dedicated Railway runtime service account. Grant bucket-scoped
  `roles/storage.objectUser` only. V4 URLs are signed with the credential's
  private key; if IAM `signBlob` replaces local signing, grant token-creator on
  that dedicated account only, never project-wide.
- Store the JSON only in Railway's sealed `GCP_SERVICE_ACCOUNT_JSON` variable.
  `run-service.sh` materializes it with mode 0600 under `/tmp` at container
  runtime. It never enters the repository or image build output.
- Railway does not copy sealed variables into preview environments. Configure
  `GCP_SERVICE_ACCOUNT_JSON` explicitly for every preview service.
- Rotate the key every 90 days: create a second key, update API and both cron
  services plus preview, redeploy and pass signing/read/upload checks, disable
  the old key, observe for 24 hours, then delete it. Record owner, dates, key
  identifier (not key material), and verification evidence in the operations
  log.

Required variables are `DATABASE_URL`, `DJANGO_SECRET_KEY`, `AUTH_SECRET`,
`DJANGO_ALLOWED_HOSTS`, `CORS_ALLOWED_ORIGINS`, `CSRF_TRUSTED_ORIGINS`, provider
keys, `DEPTH_WORKER_TOKEN`, `CRON_SECRET`, `SET_TOKEN_SECRET`, `MEDIA_BACKEND=gcs`,
`GCP_PROJECT_ID`, `GCP_MEDIA_BUCKET`, optional `GCP_MEDIA_CDN_URL`, and the
sealed JSON above. `AUTH_SECRET` must match the rollback Next API.

## Database adoption

Before any migration record is written, use a read-only database credential:

```sh
python manage.py showmigrations
python manage.py schema_preflight
```

Resolve every reported mismatch. With an approved write window, run exactly
once against the existing database:

```sh
python manage.py schema_preflight --adopt
python manage.py migrate --plan
python manage.py migrate --noinput
python manage.py schema_preflight --require-adopted
```

Historical migrations are preserved. The adoption migrations change Django
state only because the corresponding tables, columns, and indexes already
exist. All later schema changes must be normal Django migrations.

## Services and schedules

Create three Railway services from the `backend/` source bundle and manage their runtime
settings through `.railway/railway.ts`. Railway no longer permits newly created services
to opt into the deprecated per-service `railway.json` format:

- API: start with `./run-service.sh api`; health is `/api/health`.
- Login cleanup: start with `./run-service.sh login-cleanup`, daily at `17 3 * * *` UTC.
- Video reconciliation: start with `./run-service.sh video-reconciliation`, every 15 minutes.

The IaC definition refuses to evaluate outside `cutover-preview`. Production activation
requires a separately reviewed production environment definition after the observation
gate; do not remove the guard during preview preparation.

Both cron commands are bounded, terminate, and close Django connections.
Railway skips a run while the preceding invocation is active. Enable these and
remove the two Vercel cron schedules in the same scheduler-ownership window.

Create the same three services in an isolated Railway preview environment first.
Use a disposable PostgreSQL database and dedicated preview GCS bucket/service
account. Preview variables are not inherited implicitly: populate and verify the
name-only inventory for every service. Production services may be linked and
configured, but their deployment and schedules remain paused during preparation.

Do not put `DATABASE_URL`, Django secrets, provider keys, `CRON_SECRET`,
`DEPTH_WORKER_TOKEN`, or GCP private-key material in Vercel. Vercel needs only
browser-visible `VITE_*` settings for this cutover. `VITE_API_URL` and
`VITE_MEDIA_ORIGIN` must be exact HTTPS origins; the guarded build uses them to
construct the CSP.

## Preview, cutover, and rollback

1. Deploy the preview API and preview crons from the release commit. Keep cron
   schedules paused and invoke them manually for acceptance. Verify health,
   catalog, migration state, GCS operations, and read-only routes.
2. Set a Vercel preview's `VITE_API_URL` to the Railway origin and run
   the full acceptance suite. Preview users sign in once because cookies are
   host-only to Railway.
3. After parity passes, record deployment IDs, spend and zero-residue cleanup in
   the go/no-go package. Do not proceed until its production read-only gate is
   complete after 2026-09-10.
4. In the separately approved launch window, perform the single reversible flip by
   setting `VITE_API_URL` and redeploying Vercel.
5. Monitor auth/CORS errors, 4xx/5xx, queue depth, stale videos, provider
   outcomes, storage failures, DB connections, and cron completion for seven
   days.
6. Roll back by promoting the retained pre-cutover Next deployment. Keep
   Django schema changes backward-compatible throughout this window.
7. After seven stable days, delete `src/app/api`, Vercel cron definitions,
   unused server dependencies/secrets, and Drizzle migration/config tooling.
   Retain `tsx` only if a remaining script needs it.

Never run a billed provider probe, production schema write, IAM change, secret
creation, or production deployment without its separate operational approval.
