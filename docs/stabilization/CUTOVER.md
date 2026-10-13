# Green cutover to the versioned image (gate A1) — runbook

Replaces env-injected launcher code with the image built from this branch
(`backend/Dockerfile`, entrypoint `python -m deploy.entrypoint <component>`).
**Do not execute without explicit owner approval.** No values belong in this
file; values are moved privately from the current launcher configuration.

## Preconditions
- P0 backups present and restore-verified (Green + Blue); rollback set recorded per service
  (deployment id, image digest, start command, exact variable values, hash-pinned, private).
- Branch tests green: backend suite in the production-equivalent image, frontend suite, build.
- Migration graph: `migrate --plan` → no operations against a fresh restore of production.
- A quiet window: no queued/running generations, no active exports (check before each service).

## Variables per service (names only)
Common (all four):
`DATABASE_URL` (runtime role: API → api role, workers → worker role; internal host),
`VEEVEE_DATABASE_CA_PEM`, `GCP_ADC_JSON`, `DJANGO_SECRET_KEY`, `AUTH_SECRET`,
`DJANGO_ALLOWED_HOSTS=127.0.0.1`, `DJANGO_BROWSER_ORIGINS` (veevee.ai, www.veevee.ai, current
frontend deployment origins), `PUBLIC_APP_URL=https://veevee.ai` (fixes F-01),
`VEEVEE_MEDIA_BACKEND=gcs`, `GCP_MEDIA_BUCKET`, `GCP_PROJECT_ID`, `GCP_SERVICE_ACCOUNT_EMAIL`,
`VEEVEE_MEDIA_PREFIX`, `MOCK_GENERATION=0`, `MOCK_ASSET_PROVIDER=0`, `AWS_EC2_METADATA_DISABLED=true`,
`VEEVEE_PAID_GUARD` (JSON: unlimited scope + `unlimited_new_jobs: true`).

API only: `PORT=18081`, `VEEVEE_INGRESS_SECRET` (same value the Vercel middleware sends),
`VEEVEE_EXPORT_ADMISSION=1`, `VEEVEE_PORTRAIT_LIFECYCLE=1`, provider keys
(`ARK_API_KEY`, `ARK_BASE_URL`, `GOOGLE_API_KEY`, `SEEDANCE_MODEL`, `SEEDANCE_MODEL_FAST`),
BytePlus asset-library keys (`BYTEPLUS_ACCESS_KEY_ID`, `BYTEPLUS_SECRET_ACCESS_KEY`,
`BYTEPLUS_ARK_REGION`), `DEPTH_WORKER_TOKEN` (fixes F-04 with the gateway depth routes).

Generation worker: provider keys as above, `VEEVEE_LEASE_PREFIX`, `VEEVEE_NAMING_PREFIX`
(exact current values — they are live state).
Export worker: `VEEVEE_EXPORT_ADMISSION=1`, `VEEVEE_LEASE_PREFIX`, `VEEVEE_NAMING_PREFIX`.
Scheduler: `VEEVEE_LEASE_PREFIX`, `VEEVEE_NAMING_PREFIX`.

Start commands: `python -m deploy.entrypoint api|generation|export|scheduler`.
API health check stays `/__g4_readiness`; API overlap 20 s / drain 30 s; generation worker
overlap 0 / drain 120 s (one claimant at a time).

## Order (one service at a time, verify before the next)
1. Build the image from this branch; record its digest.
2. **API**: stage variables with `--skip-deploys`, verify exact readback (names + value hashes),
   set start command and source image, deploy. Verify readiness, `/api/health` through
   veevee.ai, login, history, media redirect (`private, no-store`), a portrait list, depth
   status, enqueue path for an owner-approved single test generation.
3. **Generation worker**: confirm no queued/running jobs; deploy (overlap 0). Verify admission
   log, that a queued job is claimed exactly once (ledger RESERVED→ATTEMPTING→SUBMITTING).
4. **Export worker**, then **scheduler**: deploy; verify an export ZIP (filenames, MOV hash) and
   scheduler leader lease.
5. Watch the rollback thresholds in `STATUS.md` for at least one full reconciliation window.

## Rollback (per service, as a set — never source alone)
Restore the recorded variable values (`railway variable set --skip-deploys --stdin`), restore the
recorded start command and source image, then redeploy/rollback to the recorded deployment.
Never re-run provider requests; uncertain jobs stay uncertain.
