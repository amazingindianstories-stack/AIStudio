# Django backend release runbook

Status: **UNEXECUTED — implementation and disposable qualification only.**
This document is a prepared release procedure, not permission to access shared
systems or deploy. The detailed gates and evidence ledger are in
[the cutover runbook](docs/django-migration/cutover-runbook.md).

## Release topology

| Service | Build/config | Start command | Responsibilities |
|---|---|---|---|
| Railway API | `backend/Dockerfile`, `backend/railway.toml` | Image Gunicorn command | Django/DRF HTTP API and health |
| Railway generation worker | `Dockerfile.worker`, root `railway.toml` | `python manage.py generation_worker` | Admission, durable receipts, providers and polling |
| Railway export worker | `backend/Dockerfile`, `backend/railway-export.toml` | `python manage.py media_export_worker` | Frozen manifests and private archive production |
| Railway scheduler | `backend/Dockerfile`, `backend/railway-scheduler.toml` | `python manage.py run_scheduler` | Reconciliation and maintenance |
| Vercel frontend | `package.json`, `next.config.js` | Next.js frontend | UI and same-origin API transport |

All Railway roles use the same reviewed Python source revision. The external
GPU depth process remains a separate authenticated client. Database migrations
run as a controlled release action, never from these start commands or a Vercel
build. No Node generation/export worker remains in the proposed deployment.

## Before a separately authorized cutover

1. Record exact source revision, image digest, local qualification results and
   remaining live-provider evidence. Require PostgreSQL 16 fresh-schema,
   populated-adoption, full Django (including media), frontend lint/unit/build,
   and browser-through-Django results. Do not substitute a final-schema setup for
   an upgrade/adoption rehearsal.
2. Verify actual target database, storage primary/fallback, Railway service roles,
   Vercel environment and callback/public origins without printing secrets.
   Historical production ownership remains unchanged until transfer is executed.
3. Create and verify backup/PITR and rehearse recovery to a separate database.
   Capture protected catalog/history and full organization/media/name snapshots.
4. Drain generation/export work and freeze mutations across *all* old writers,
   including Node routes, old workers, scheduler, callbacks, admin tools and depth
   claims. Keep provider receipts for in-flight remote tasks; do not resubmit them.
5. Reconcile actual production catalog and migration history with the reviewed
   baseline. Block on unknown history, missing/default-altered columns, invalid
   indexes, changed triggers/functions or differing constraints. Never run fresh
   CreateModel migrations on populated tables or blind `--fake-initial`.
6. Perform the separately reviewed history-only baseline adoption, then any
   additive Django migrations. Reopen connections and verify the committed graph,
   exact schema and unchanged existing rows before application promotion.
7. Deploy the Python API and workers with one authoritative writer set. Switch the
   frontend transport only after readiness and contract smoke checks pass. Stop
   old execution paths before enabling new worker ownership.
8. Verify hosted cookies/origin forwarding, signed media and uploads, organization
   writes, every generation kind, callbacks, depth claim fencing, archive v1/v2
   handling and frozen names. Confirm real Seedance MOV container/colour/bytes on
   an explicitly authorized provider acceptance run; mocks cannot prove it.
9. Verify release identity/logs and remove backend secrets from Vercel. Record
   evidence for traffic/schema ownership transfer, then lift the write freeze.

Organization preservation requires zero unapproved additions/losses or changes
to existing project/folder/generation IDs, parent/project/folder assignments,
global/project unsorted membership, durable media references, naming namespaces,
serials/counters and frozen export items. Counts alone are insufficient.

## Rollback and failure handling

A migration or preservation failure blocks promotion; keep writers frozen.
Roll back application images/transport only to a previously qualified compatible
release. Preserve additive schema and accepted provider task receipts. Do not
run destructive down-migrations, delete production records or roll an export
worker back to a version that cannot read queued/finalized manifests.

Reactivating historical Node writers after Django adoption is not a default
rollback. It requires an explicitly reviewed compatibility plan and write freeze;
otherwise restore a prior compatible Django release. For corruption, restore
PITR into an isolated recovery database, verify full invariants, then perform an
authorized target switch. Never overwrite the original database as a diagnostic.

## Environment separation

`.env.local.example` contains only frontend transport/public UI settings.
`backend/.env.example` lists backend configuration names without credentials.
Neither file is automatically loaded by Django. Inject reviewed runtime values
through the platform secret store. Keep provider/storage/session/database keys
off Vercel and out of logs, source archives and image build contexts.

Railway-to-PostgreSQL TLS/IAM connectivity must be independently verified. A
historical Node Cloud SQL connector configuration does not establish a working
Python connection. Configure explicit HTTPS browser origins and allowed hosts;
never replace them with wildcards to bypass proxy/cookie problems.

## Goal 2 prepared local changes — external steps UNEXECUTED

Review assets.0004_uploader_provenance and media.0001_uploadsession with the existing
generation additive migration before a controlled release. Local PG16 fresh and
upgrade probes preserve historic rows and independently compare full catalogs.
Never migrate at API, worker or Vercel startup. Native resumable GCS still needs
separate authorized CORS/session/finalize/ingress acceptance. Schedule bounded
`cleanup_uploads` only after operator review: it collects expired incomplete
private uploads, excludes READY references and shared catalog originals. READY
references remain durable for restored drafts/history; no age-only deletion of
READY files is permitted. AUTH_SECRET rotation invalidates unfinished encrypted
resume sessions. Read-only viewer requires target and database-role verification
in addition to the application guard. No deployment/cutover was executed here.
