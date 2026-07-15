# GCP Migration and Scale Plan

**Last audited:** 2026-07-14  
**Application:** Vercel project `aistudio-v1`  
**GCP project:** `ais-project-for-gcp` (`303288602776`)  
**Change policy:** this work is intentionally uncommitted and unpushed; Claude
will combine it with the canvas-board work and push after review.

## Decision

The revised architecture is viable for the long term. It follows the normal
large-site split:

- Vercel serves the Next.js UI and short API/orchestration requests.
- Cloud SQL owns transactional application data.
- Cloud Storage owns binary media.
- Cloud CDN delivers large media directly, without proxying bytes through
  Vercel.
- A later Cloud Tasks + Cloud Run worker tier owns long-running generation and
  media-processing jobs.

The old version of this document was directionally useful but not sufficient as
an implementation plan. It assumed the database/storage locations rather than
auditing them, recommended AWS CloudFront even though the target is GCP, and did
not cover identity federation, cutover, rollback, connection limits, backups,
or private media delivery. Those gaps are corrected here.

## Exact Current Locations

### Production source before cutover

- **App:** Vercel team `amazing-indian-stories`, project `aistudio-v1`.
- **Postgres:** Railway, not GCP.
  - Host: `junction.proxy.rlwy.net`
  - Port: `10177`
  - Database: `railway`
  - Engine observed on 2026-07-14: PostgreSQL 18.4
  - Size observed: about 9.4 MB
  - Rows observed: 251 generations, 12 users, 8 canvas boards, 4 projects,
    4 folders, 362 activity records, 10 pricing records, and 0 assets.
  - Extensions: only `plpgsql`; there is no extension migration risk.
- **Media:** AWS S3 through the application's `/api/media/*` Vercel route.
- **Model execution:** external APIs: Google Gemini, BytePlus ModelArk, and
  Higgsfield MCP. These are not hosted by Vercel or by this GCP project, except
  where a provider is explicitly configured for Vertex AI.

### GCP targets

- **Cloud SQL:** `ais-project-for-gcp:us-central1:aistudio-db`
  - Target database: `aistudio`
  - IAM runtime user: `aistudio-media-sa@ais-project-for-gcp.iam`
  - The source and target are being aligned on PostgreSQL 18 before import.
  - Current size is intentionally small (`db-f1-micro`) because production data
    is tiny. It is a cost-efficient starting tier, not the final HA tier.
- **Cloud Storage:** `gs://aistudio-media-bucket`, `US-CENTRAL1`
  - Existing objects: about 1.88 GB at audit time.
  - This is the canonical bucket. The empty
    `gs://aistudio-media-bucket-gcp` bucket is not used.
- **Service account:**
  `aistudio-media-sa@ais-project-for-gcp.iam.gserviceaccount.com`.
- **Vercel identity:** Workload Identity Pool `vercel-pool`, provider
  `vercel-provider`; no service-account key file is required.

## Why Vercel Reached 75%

The application returns media references as `/api/media/<object-key>`. That
route reads videos/images from object storage and streams them through a Vercel
function. Consequently, every viewed media byte crosses Vercel's origin path.
Video range requests make this especially expensive.

The durable fix is not simply moving S3 to GCS. If `/api/media` continues to
stream GCS bytes, Vercel transfer remains. The fix implemented in this branch is:

1. Keep stable `/api/media/*` database URLs.
2. When `GCP_MEDIA_CDN_URL` is configured, return a 307 redirect to Cloud CDN.
3. Let Cloud CDN fetch from the private GCS bucket and serve the bytes globally.

This preserves old database rows while moving the expensive data path away from
Vercel.

## Should Vercel Pro Be Purchased?

**Purchase Pro now if uninterrupted production service matters before this
branch is deployed and the CDN is verified.** Hobby cannot buy additional usage
after its included cap, while Pro supports additional usage and spend controls.
At 75%, the subscription is operational insurance against an automatic pause.

Pro is not the long-term media solution. After CDN offload, measure one complete
billing window. Keep Pro if team features, support, execution capacity, or the
remaining application traffic justify it; otherwise reassess. Do not downgrade
based on one quiet day.

Current plan details are maintained by Vercel and can change:
[Vercel pricing](https://vercel.com/pricing).

## Work Implemented in This Branch

### Application

- Added an explicit `MEDIA_BACKEND=s3|gcs` cutover switch. It is staged as S3
  until the object copy verifies, then GCS becomes primary.
- Kept an opt-in, temporary S3 read fallback after the GCS cutover.
- Added streaming and HTTP byte-range support for GCS media.
- Added optional CDN redirects while preserving `/api/media/*` URLs.
- Moved the Higgsfield persisted OAuth token to private GCS storage.
- Added official Vercel OIDC to GCP Workload Identity Federation using
  `@vercel/oidc`; no JSON key and no token files in `/tmp`.
- Added the Cloud SQL Node.js Connector with automatic IAM database auth.
- Added `DATABASE_BACKEND=railway|cloud-sql`; Railway remains selected until the
  final maintenance-window snapshot, and `DATABASE_URL` remains the rollback.
- Made database creation lazy so builds do not contact a database.
- Limited each runtime pool and shortened idle/connect timeouts.
- Added queue, project, folder, user-history, canvas, and activity indexes.
- Changed the admin dependency status check to report the selected media backend.
- Added repeatable, dry-run-first database and object migration scripts.
- The Postgres migration script appends the runtime IAM grants, indexes, and
  `ANALYZE` after every import, so the final clean import does not require a
  separate manual grant/index step.
- Removed the hardcoded seed password; `SEED_ADMIN_PASSWORD` is now required
  when a new admin must be created.
- Pinned runtime to Node 22.x for Vercel and upgraded Next.js to 15.5.20.
  Nested PostCSS is overridden to the patched direct dependency version.

### GCP controls already applied

- Cloud SQL automated backups enabled at 00:00 IST.
- Point-in-time recovery enabled with seven days of transaction logs.
- Fourteen automated backups retained.
- Cloud SQL IAM authentication enabled.
- Cloud SQL upgraded to PostgreSQL 18.4 Enterprise to match Railway.
- The first Railway snapshot was imported into database `aistudio`; the runtime
  IAM user passed a real read/write test (the test write was rolled back).
- Public `0.0.0.0/0` access was removed and connector enforcement is required.
- Cloud Storage uniform bucket-level access enabled.
- Cloud Storage public-access prevention enforced.
- Migration SQL snapshots expire after 30 days; user media does not.
- Runtime service account granted Cloud SQL Client, Cloud SQL Instance User,
  and bucket-level Storage Object Admin.
- Vercel WIF issuer and audience restricted to the correct team.
- Service-account impersonation restricted to exact `aistudio-v1` production
  and preview subjects; the previous whole-pool wildcard was removed.

Official references:

- [Vercel GCP OIDC](https://vercel.com/docs/oidc/gcp)
- [Cloud SQL Node.js connectors](https://docs.cloud.google.com/sql/docs/postgres/connect-connectors)
- [Cloud SQL IAM authentication](https://docs.cloud.google.com/sql/docs/postgres/iam-authentication)
- [Cloud CDN backend bucket](https://docs.cloud.google.com/cdn/docs/setting-up-cdn-with-bucket)
- [Cloud CDN caching](https://docs.cloud.google.com/cdn/docs/caching)

## What Is Deliberately Not Live Yet

- No code has been committed, pushed, or deployed.
- Railway is still authoritative and serving production writes.
- S3 remains authoritative until the copy and verification finish.
- Non-secret GCP/Cloud SQL variables are staged in Vercel production/preview,
  but the safety gates remain `DATABASE_BACKEND=railway` and
  `MEDIA_BACKEND=s3`.
- Cloud CDN has not been provisioned because the final media hostname is not
  known. `infra/gcp/bootstrap-media-cdn.sh` is ready and requires that hostname.
- The bucket contains 228 older, flat-layout objects. Railway currently
  references 508 unique media keys and none exists under its exact current GCS
  path. The S3 copy is therefore mandatory.
- AWS values are Vercel Sensitive Environment Variables and cannot be exported
  by the CLI. An operator must supply a new/read-only AWS key locally, or rotate
  the Vercel variables to recoverable values, before the migration command can
  inventory and copy S3.
- The Cloud Tasks/Cloud Run worker plane is a later scaling stage, not part of
  this database/storage cutover.

## Safe Cutover Runbook

### 1. Initial copy while production stays online

```bash
npm run migrate:postgres:gcp
npm run migrate:postgres:gcp -- --apply
npm run migrate:media:gcp
npm run migrate:media:gcp -- --apply
npm run migrate:media:gcp -- --verify-only
npm run verify:media:gcp
```

The first form is a dry run. Database snapshots are stored under
`gs://aistudio-media-bucket/migrations/` for 30 days. The media migration is
idempotent and recopies missing or size-mismatched objects. The initial database
copy is complete; rerun it only for rehearsal or final sync. The media commands
remain blocked until usable AWS credentials are supplied.

### 2. Verify target behavior before production switch

- Compare row counts for every table on Railway and Cloud SQL.
- Run application read/write smoke tests against Cloud SQL through the connector.
- Verify a newly uploaded image, a large video, and a byte-range request in GCS.
- Verify the GCS admin status row reports healthy.
- Confirm no service-account JSON file exists in Vercel.

### 3. Final database sync

1. Put generation creation and admin writes into maintenance mode.
2. Wait for running generation jobs to settle or mark them for retry.
3. Run the database migration again. Its dump uses `--clean --if-exists`, so
   the target is replaced with one consistent final Railway snapshot.
4. Re-run row-count and recent-record comparisons.
5. Confirm the appended post-import SQL completed: runtime IAM grants, indexes,
   and `ANALYZE`.
6. Keep schema ownership and DDL with the built-in admin account.

Expected write outage is minutes for this 9.4 MB database.

### 4. Deploy safely, then switch gates

The non-secret GCP variables are already staged. Keep `DATABASE_URL` and AWS
credentials for rollback. Claude can deploy the merged branch while the gates
remain Railway/S3; this should preserve current behavior.

After the final database sync, set `DATABASE_BACKEND=cloud-sql` and redeploy.
After the media verification reports zero missing/different objects, set
`MEDIA_BACKEND=gcs` and redeploy. Verify login, history, canvas, generation
enqueue, upload, playback, admin status, and token refresh after each gate so a
database issue and a storage issue cannot be introduced in the same cutover.

Keep `GCS_MIGRATION_READ_FALLBACK=1` during the observation window after the
media gate changes. New writes go to GCS; missing old objects can still be read
from S3.

### 5. CDN switch

1. Select a hostname such as `media.<production-domain>`.
2. Run `MEDIA_DOMAIN=<hostname> ./infra/gcp/bootstrap-media-cdn.sh`.
3. Create the printed DNS A record.
4. Wait for the Google-managed certificate to become `ACTIVE`.
5. Set `GCP_MEDIA_CDN_URL=https://<hostname>` in Vercel.
6. Verify a second request has a positive `Age` header and Vercel returns 307.

The bucket stays private; only the HTTPS load-balancer service account receives
read access.

### 6. Remove rollback credentials

After at least seven stable days and one successful backup/restore drill:

- Set `GCS_MIGRATION_READ_FALLBACK=0`.
- Remove AWS credentials from Vercel.
- Remove Railway `DATABASE_URL` from Vercel.
- Retain Railway and S3 without writes for the agreed rollback window, then
  cancel them only after a final audit export.

## Rollback

- **Before final sync:** no rollback is needed; production still uses Railway/S3.
- **After deploy, before new GCP writes matter:** set `DATABASE_BACKEND=railway`
  and `MEDIA_BACKEND=s3`, then redeploy.
- **After new GCP writes:** do not blindly switch back. Freeze writes, export the
  GCP delta, reconcile it into Railway/S3, then redeploy.
- CDN can be disabled independently by clearing `GCP_MEDIA_CDN_URL`; the stable
  route then streams from GCS again.

## Long-Term Expansion Plan

### Traffic layer: automatic now

Vercel, GCS, and Cloud CDN scale horizontally without application-managed
servers. Immutable object keys and one-year cache metadata maximize cache hits.
Add image thumbnails/posters so list pages never load full originals.

### Database layer: threshold-driven, not falsely "automatic"

Cloud SQL storage auto-growth is enabled, but CPU/RAM and HA do not magically
scale on the current shared-core instance. Treat these as explicit thresholds:

- Upgrade from `db-f1-micro` when CPU exceeds 60% for 15 minutes, memory pressure
  appears, p95 query latency exceeds 100 ms, or connections exceed 60% of limit.
- Move to a custom two-vCPU tier before meaningful public growth.
- Enable regional HA before the site has an uptime/SLA requirement or paid
  customers; the current zonal instance does not survive a full zonal outage.
- Enable Query Insights and review slow queries/index use monthly.
- At serverless connection spikes, use Cloud SQL Enterprise Plus Managed
  Connection Pooling or place the API/worker behind a controlled pooler. Keep
  per-instance pools small meanwhile.

References:
[manage connections](https://docs.cloud.google.com/sql/docs/postgres/manage-connections),
[managed connection pooling](https://docs.cloud.google.com/sql/docs/postgres/managed-connection-pooling),
[high availability](https://docs.cloud.google.com/sql/docs/postgres/high-availability).

### Worker layer: next architectural milestone

Long provider calls should leave request-driven Vercel functions:

1. Vercel validates and creates a job row.
2. Vercel enqueues a Cloud Task with job ID and idempotency key.
3. A private Cloud Run worker processes the provider call and writes GCS/SQL.
4. Cloud Tasks controls retry, rate, concurrency, and dead-letter handling.
5. Cloud Run scales by queue pressure but has a configured maximum so model API
   limits and database connections cannot be overwhelmed.

The existing `generations` table can remain the user-visible job ledger. The
worker must use leases/idempotency so at-least-once delivery cannot bill twice.

### Operational controls

- Budget alerts: Vercel, Cloud SQL, Cloud Storage/CDN egress, model providers.
- Alerts: database CPU/connections/storage, 5xx rate, task retry depth, oldest
  queued job, provider error rate, CDN hit ratio.
- Quarterly restore drill from Cloud SQL backup.
- Per-user generation quotas and request rate limits before public launch.
- Explicit media retention policy before adding automatic deletion of user data.
- Separate production and preview service accounts/buckets once preview usage
  becomes nontrivial; the current exact-subject WIF rules are secure but share
  one runtime identity.

## Final Assessment

This is a strong long-term direction when completed in stages. GCS alone does
not solve the Vercel warning; the Cloud CDN redirect is the part that removes
large media transfer. Cloud SQL is appropriate for this small relational data
set and can grow substantially, but the current micro/zonal tier must be treated
as a starting point with measured upgrade thresholds. Cloud Tasks + Cloud Run is
the next scale boundary once generation volume, reliability, or Vercel function
duration becomes a real constraint.

## Verification Notes

Completed on 2026-07-14:

- `npx tsc --noEmit --incremental false`
- 228 unit tests via `npx tsx --test`
- `npm run migrate:postgres:gcp` dry run
- `npm run verify:media:gcp` confirmed the media migration is still blocked:
  508 referenced objects are missing from GCS.
- `npm run build` on Next.js 15.5.20
- `npm audit --omit=dev` has 5 remaining moderate findings in the Google
  Storage v7 auth stack (`uuid` through `gaxios`/`teeny-request`). The npm
  `--force` fix would downgrade `@google-cloud/storage` across a major version,
  so this should be handled as a deliberate SDK follow-up.
