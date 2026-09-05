# Django + React cutover go/no-go package

Status: **NOT READY / preparation only**

Earliest production decision: **2026-09-10, after the AWS/GCS observation gate**

Current external blockers: Railway preview provisioning requires an active plan;
GCP preview bucket/service-account provisioning requires interactive CLI
reauthentication. The 2026-09-05 attempts made no partial infrastructure change.

Release branch: `migration/restore-django-cutover`

This is the signable evidence record. A blank checkbox is a failed gate. Do not
interpret a locally passing test as deployed acceptance. Do not merge, adopt the
production schema, enable production schedules, change production Vercel variables,
or move traffic while this document remains unsigned.

## Immutable release identity

- [ ] Release commit: `________________________________________`
- [ ] Pull request: `________________________________________`
- [ ] GitHub Actions run: `________________________________________`
- [ ] `django` check conclusion / ID: `________________________________________`
- [ ] `web` check conclusion / ID: `________________________________________`
- [ ] `database` check conclusion / ID: `________________________________________`
- [ ] Vercel preview deployment ID: `________________________________________`
- [ ] Stable Vercel preview alias: `________________________________________`
- [ ] Railway preview API deployment ID/origin: `________________________________________`
- [ ] Railway preview login-cleanup service/deploy ID: `________________________________________`
- [ ] Railway preview reconciliation service/deploy ID: `________________________________________`
- [ ] Disposable PostgreSQL identifier: `________________________________________`
- [ ] Preview GCS bucket/service-account names: `________________________________________`

## Named operators

| Responsibility | Name | Approval/time |
|---|---|---|
| Release commander and go/no-go |  |  |
| Database adoption |  |  |
| Railway API and cron activation |  |  |
| Vercel traffic flip and rollback |  |  |
| GCS/IAM and final inventory |  |  |
| Provider-spend observer |  |  |
| GPU depth worker |  |  |
| Seven-day monitoring owner |  |  |

## Local and CI gates

- [ ] 419 Django tests pass against PostgreSQL.
- [ ] `python manage.py check` passes.
- [ ] `python manage.py makemigrations --check --dry-run` reports no changes.
- [ ] Django/retained-route method inventory parity passes.
- [ ] 787 Vitest cases pass.
- [ ] ESLint passes with zero warnings.
- [ ] Guarded Vite production build passes with exact `VITE_API_URL`.
- [ ] No `.ts` or `.tsx` source files exist.
- [ ] `git diff --check` passes.
- [ ] The Vite module graph contains no API/server, database, provider, worker,
      cron, private-key, storage-credential, or secret-handling module.
- [ ] Built `dist/index.html` CSP contains only self, the exact preview API,
      and `https://storage.googleapis.com`; it contains no bare `https:` source.

Evidence: `__________________________________________________________________`

## Preview isolation and configuration

- [ ] Preview API and both preview cron services deploy only the release commit.
- [ ] Preview PostgreSQL is disposable and has no production connection path.
- [ ] Preview GCS bucket and service account are dedicated to preview.
- [ ] Service-account permission is bucket-scoped object access only.
- [ ] Preview CORS/CSRF lists contain the exact stable Vercel preview origin.
- [ ] Vercel preview `VITE_API_URL` is the exact Railway preview API origin.
- [ ] Django allowed hosts contain only the assigned API host(s).
- [ ] Production Railway services exist but deployment and schedules remain paused.
- [ ] Production `VITE_API_URL` is prepared but no production redeploy occurred.

### Name-only secret inventory

Record presence/absence, never values. The API and both cron services require only
the names applicable to their execution paths:

`DATABASE_URL`, `DJANGO_SECRET_KEY`, `AUTH_SECRET`, `DJANGO_ALLOWED_HOSTS`,
`CORS_ALLOWED_ORIGINS`, `CSRF_TRUSTED_ORIGINS`, `CRON_SECRET`,
`SET_TOKEN_SECRET`, `DEPTH_WORKER_TOKEN`, `MEDIA_BACKEND`, `GCP_PROJECT_ID`,
`GCP_MEDIA_BUCKET`, `GCP_MEDIA_CDN_URL`, `GCP_SERVICE_ACCOUNT_JSON`, and the
provider-key names used by the enabled model registry.

- [ ] Preview inventory recorded: `________________________________________`
- [ ] Production Railway inventory recorded: `________________________________________`
- [ ] Vercel contains browser-visible `VITE_*` values only for the cutover.
- [ ] Vercel contains no database, provider, worker, cron, GCP private-key, or
      Django secret credential required solely by the new runtime.

## Preview workflow acceptance

Use disposable users, projects, assets, generations, boards, conversations, and
object prefixes. Record fixture IDs in a restricted evidence file, not here.

### Authentication and authorization

- [ ] Cross-origin login sets the secure host-only cookie and returns the user.
- [ ] Session renewal works after the renewal threshold.
- [ ] Logout clears the cookie and the next authenticated request fails.
- [ ] Password change invalidates the prior token and issues the new one.
- [ ] `/`, `/login`, and `/admin` unauthenticated redirects are correct.
- [ ] A normal user cannot use admin APIs or the admin route.
- [ ] A hostile `Origin` is rejected and receives no credentialed CORS grant.

### Product flows

- [ ] Users, settings, pricing and account settings.
- [ ] Projects and folders: create, rename, scope, and delete.
- [ ] Assets: upload, list, use and delete.
- [ ] History: filters, counts, pagination, favourite/flag/folder changes and ZIP.
- [ ] Canvas: boards, persistence, reload and uploads.
- [ ] Agent conversations: create, rename, message, attachment and delete.

### GCS and delivery

- [ ] Signed upload succeeds into the preview prefix.
- [ ] Signed read and byte-range read succeed directly from GCS.
- [ ] Thumbnail and original media delivery succeed without API-byte fallback.
- [ ] Protected keys are rejected.
- [ ] Deletion is verified by a subsequent missing-object read/list.

### Queue and cron

- [ ] Queue admission, execution, polling and terminal settlement pass.
- [ ] Stale-video reconciliation repairs the isolated fixture.
- [ ] Both cron commands pass via authenticated manual invocations.
- [ ] All preview database rows and GCS objects are cleaned up.
- [ ] Cleanup counts — rows before/after: `________ / ________`; objects:
      `________ / ________`; residue: `________` (must be zero).

Evidence: `__________________________________________________________________`

## Provider probes — separate approval and US$2 hard ceiling

Before the first request, the provider-spend observer records a conservative maximum
for every probe and proves their sum plus one permitted transient retry is below US$2.
Stop immediately if the cap cannot be guaranteed. Do not retry a deterministic error.

| Probe | Maximum | Result | Actual/estimated spend | Task evidence |
|---|---:|---|---:|---|
| Nano Banana Pro, one 1K image | 1 request |  |  |  |
| Kling, one 1K text-to-image | 1 request |  |  |  |
| Seedance 2.0, 480p 4s muted | 1 request |  |  |  |
| Seedance 2.5, 480p 4s basic | 1 request |  |  |  |
| Gemini Omni, 720p 4s | 1 request |  |  |  |
| Agent path, minimal live Gemini turn | 1 request |  |  |  |
| Seedance continuation, minimum duration with existing fixture | 1 request |  |  |  |
| Optional single transient retry | at most 1 |  |  |  |
| **Combined** | **< US$2** |  |  |  |

- [ ] Total spend: `US$________` and independently checked.
- [ ] Core provider paths all passed; any core failure is a **NO-GO**.
- [ ] Failed optional capability is disabled and documented.
- [ ] Seedance audio remains disabled unless separately evidenced.
- [ ] Unsupported Kling seed/2K-reference combinations remain disabled.
- [ ] Seedance continuation remains disabled unless its probe passed.

## Mandatory depth gate

- [ ] Healthy GPU-worker heartbeat is visible from the preview API.
- [ ] `vits`: upload → claim → progress → complete → media read → cleanup.
- [ ] `vitb`: upload → claim → progress → complete → media read → cleanup.
- [ ] `vitl`: upload → claim → progress → complete → media read → cleanup.
- [ ] A claimed job was deliberately interrupted.
- [ ] The terminated worker's claim was fenced from further mutation.
- [ ] Stale recovery re-queued/resumed the job and it completed.
- [ ] Database and GCS cleanup left zero depth-fixture residue.

Evidence/worker label: `_____________________________________________________`

Any unchecked depth item is a **NO-GO**; do not expose depth unverified.

## Production read-only gate — do not run before 2026-09-10

- [ ] Final S3/GCS inventory comparison is complete.
- [ ] Database-referenced GCS objects missing: `0`.
- [ ] S3 fallback activity during the observation window: `0`.
- [ ] A recent object uses direct signed delivery and range read.
- [ ] `showmigrations` captured with a read-only credential.
- [ ] `schema_preflight` passes without adoption.
- [ ] Expected tables, columns and indexes match the catalog.
- [ ] Database connection headroom is accepted: `used ____ / max ____`.
- [ ] Queue/stale-running/stale-video row counts are accepted.
- [ ] Current login-cleanup and reconciliation ownership/health are recorded.
- [ ] Production frontend/API domains and exact CORS/CSRF/CSP lists match.
- [ ] Cookie flags are Secure, HttpOnly, SameSite=None, Path=/, host-only.
- [ ] Railway `/api/health` is ready on the candidate deployment.
- [ ] Retained pre-cutover Next deployment ID and promotion command are tested
      read-only and available.

Evidence: `__________________________________________________________________`

## Approved launch sequence (later window only)

These commands are templates. The database operator must export an approved production
`DATABASE_URL` without printing it. Stop on the first non-zero exit.

```bash
cd backend
python manage.py showmigrations
python manage.py schema_preflight
python manage.py schema_preflight --adopt
python manage.py migrate --plan
python manage.py migrate --noinput
python manage.py schema_preflight --require-adopted
```

Then, in order:

1. Deploy/unpause the production Railway API at the signed release commit.
2. Verify `/api/health`, migration state, catalog, GCS signing/read, and queues.
3. Deploy the production Vite build with the prepared exact `VITE_API_URL`.
4. Transfer scheduler ownership: disable legacy schedules, then enable both
   Railway cron schedules; never run both owners concurrently.
5. Verify browser traffic, cross-origin auth, representative reads and one bounded
   non-provider write with cleanup.
6. Begin seven-day monitoring. Keep all rollback resources.

## Rollback triggers and command

Immediate rollback triggers: authentication/session failure, incorrect CORS/CSP,
schema/catalog mismatch, sustained 5xx/error increase, queue non-drain, stale jobs,
media signing/range/fallback failure, provider settlement error, cron overlap/miss,
or any depth fencing/recovery failure.

Prepared retained deployment ID: `________________________________________`

```bash
# Run by the Vercel rollback operator after replacing the placeholder.
vercel promote <retained-pre-cutover-deployment-url-or-id> --scope <team>
```

After promotion, verify the three browser routes and the retained Next API, disable
Railway production schedules, keep the Django service available for diagnosis, and do
not reverse an already-applied backward-compatible adoption migration. Record timestamps
and preserve logs.

## Seven-day monitoring record

Run at least hourly for the first four hours, then daily through day seven. Store query
outputs in the restricted release evidence location.

| Signal/query | Baseline/threshold | Owner | Day 0–7 evidence |
|---|---|---|---|
| Django auth failures by code and route | compare baseline; alert on step change |  |  |
| CORS `UNTRUSTED_ORIGIN` counts/origins | unknown origins investigated |  |  |
| HTTP 4xx/5xx by route and deploy | no sustained 5xx increase |  |  |
| queued/running counts and oldest age | drains within configured deadlines |  |  |
| stale running/video reconciliation rows | zero unexplained stale rows |  |  |
| GCS sign/read/range/delete failures | zero sustained failures |  |  |
| media fallback/proxy count | zero |  |  |
| DB active/idle/waiting connections | below accepted capacity |  |  |
| provider submit/poll/outcome/cost | no settlement or spend anomaly |  |  |
| login-cleanup completion | one successful daily run |  |  |
| video-reconciliation completion | expected 15-minute cadence |  |  |
| depth heartbeats, claims and stale recovery | healthy; no unfenced mutation |  |  |

## Decision

- [ ] **GO** — every mandatory gate is checked and all named operators sign below.
- [ ] **NO-GO** — blocker IDs/evidence: `______________________________________`

Release commander: `________________`  Signature/time: `________________`

Database operator: `_________________`  Signature/time: `________________`

Platform operator: `_________________`  Signature/time: `________________`

Monitoring owner: `__________________`  Signature/time: `________________`

Preparation ends here. The launch sequence is a later, separately approved operation.
