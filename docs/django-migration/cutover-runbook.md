# Prepared Railway/Vercel cutover

**All live steps below are UNEXECUTED.** Local code authority and disposable
qualification do not transfer production traffic or schema ownership. This
implementation-only goal prohibits shared target access, real provider/cloud
calls, deployment, push and merge. A later explicit release authorization is
required before executing this plan.

## Authority and topology

Django/DRF and Python workers are the local backend/schema authority. The active
managed migration graph has 21 application models and one history. The frozen
historical catalog/DDL and outputs are comparison evidence only. Production's
last recorded Node/Drizzle ownership remains in `route-ownership.yaml`; update it
only from actual release evidence, never from test completion.

Railway runs four separate roles from reviewed Python images: API
(`backend/railway.toml`), generation (root `railway.toml`), exports
(`backend/railway-export.toml`) and scheduler (`backend/railway-scheduler.toml`).
The external depth GPU process continues its existing HTTP protocol. Next.js on
Vercel handles UI and transparent same-origin `/api` transport with
`DJANGO_API_ORIGIN`; it has no backend secrets and performs no schema work.

The scheduler uses database leases per aligned UTC minute, 15-minute video/export
interval and daily 03:17 login-cleanup interval. Startup catches up the current
slot. This provides at-most-once slot dispatch with idempotent/fenced work, not an
exactly-once guarantee for external side effects after crashes. API cron routes
retain their exact machine authentication and invoke the same Python services.

## Gates and evidence ledger

| Gate | Required release evidence | Live state |
|---|---|---|
| Target inventory | Actual database identity/TLS, storage primary and read-only fallback, service role, exact source/image identities | UNEXECUTED |
| Recovery | Verified backup/PITR timestamp and isolated restore rehearsal | UNEXECUTED |
| Write freeze | All historical routes/workers/schedulers/callback writers paused or fenced; outstanding remote task IDs recorded | UNEXECUTED |
| Baseline preflight | Exact catalog/default/index/FK/trigger/function/sequence comparison and reviewed migration history | UNEXECUTED |
| Populated adoption | Reviewed history-only operation with DDL blocked; identical before/after rows and organization/media/naming snapshots | UNEXECUTED |
| Controlled migrations | Committed Django graph verified after reconnect; fresh and prior-state upgrade evidence for any later migrations | UNEXECUTED |
| API/worker readiness | Railway health, actual DB/storage connectivity, role isolation, startup without migrations, durable recovery | UNEXECUTED |
| Frontend routing | Hosted same-origin forwarding, cookies, exact Origin checks, request IDs, no backend fallback | UNEXECUTED |
| Functional smoke | Auth, hierarchy, history, portraits, canvas, agents, generation, callbacks, depth, exports and downloads | UNEXECUTED |
| Provider acceptance | Separately approved bounded real probes; native Seedance MOV and original-byte persistence/download proof | UNEXECUTED |
| Secrets and ownership | Backend secrets removed from Vercel, old writers retired, traffic/schema ownership evidence and rollback window | UNEXECUTED |

## Controlled sequence

1. Freeze the exact release artifact. Require frontend checks, all Django app
   tests including media, strict 85-method inventory, PostgreSQL 16 fresh schema
   equivalence, populated-adoption negative cases and browser qualification.
2. Verify actual shared targets and secure recovery artifacts. Audit current
   database migration history rather than assuming it matches the archived 49-row
   transitional fixture. Unknown history blocks adoption.
3. Establish the all-writer maintenance window. Capture full stable organization,
   naming, export and media-reference snapshots. No generation/project/folder
   additions are allowed between preservation snapshots.
4. Run the separately reviewed production baseline plan. Existing tables must
   not receive CreateModel DDL. Exact-equivalence history-only adoption is a
   distinct operation from a fresh migration; disposable probe scripts refuse
   shared targets and are not production deployment commands.
5. Apply later additive migrations through one controlled release action. Verify
   schema/history and row preservation after reconnect. A failure blocks API,
   worker and frontend promotion. Never migrate in image startup or Vercel build.
6. Start the Django API with explicit host/origin/TLS settings and verify readiness.
   Enable Python generation, export and scheduler roles after old workers are
   stopped/fenced. Preserve accepted provider receipts and manifest compatibility.
7. Switch Vercel's same-origin transport to the verified Railway API origin. There
   is no method-by-method Node fallback in the retired local implementation.
   Verify authenticated mutations retain the original frontend Origin and renewed
   secure HttpOnly SameSite cookies. Reject invalid/unconfigured transport.
8. Run bounded smoke checks using disposable operator content. Confirm hierarchy
   conflicts/idempotency, keyset history, stable serial names, original MOV
   downloads and ZIP integrity, portrait inventories, canvas autosave, depth
   heartbeat/claim/retry fencing, webhook deduplication and worker recovery.
   Real provider checks require their own authorization/cost limits.
9. Review sanitized logs, confirm source/image identity and zero preservation
   drift, remove backend Vercel secrets, record ownership transfer, and release
   the maintenance window only after all required live evidence passes.

## Connectivity and secrets

All Python roles load explicit environment variables, never checkout dotenv.
Use `backend/.env.example` as a list of names, then platform-managed secrets.
Review PostgreSQL TLS/CA or a separately configured secure Cloud SQL connection;
Node connector/IAM behavior is not implicitly inherited. Storage primary writes
must stay isolated from any read-only historical fallback. Public/provider fetch
hosts and exact browser origins must be reviewed explicitly.

Keep `DATABASE_URL`, `DJANGO_SECRET_KEY`, `AUTH_SECRET`, provider keys, cloud
credentials, worker/cron tokens and private OAuth caches off Vercel. Its only
server backend setting is `DJANGO_API_ORIGIN`. Local loopback qualification may
use `DJANGO_API_ALLOW_LOCAL=1`; hosted origin must be HTTPS. Public UI settings
must never contain secrets. Do not print environment contents or token URLs.

## Rollback

Keep writers frozen when any gate fails. Prefer a previous qualified compatible
Django image and transport setting, preserving additive schema and accepted task
receipts. Do not revive Node writers automatically after schema authority changes.
Any legacy rollback requires a reviewed compatibility plan before the cutover.
Never drop populated schema or migration history to make code start.

Keep export workers compatible with every pending manifest version. Keep original
master objects immutable. Restore corruption to a separate PITR database, verify
all snapshots, and only then authorize a target switch. Record release identity,
incident scope, remaining writers and reconciliation status before resuming work.

## CI isolation

GitHub CI supplies the exact service container ID, network and published port to
`ci-qualification.py`. The guard inspects actual image, live PostgreSQL 16 version,
health, bridge network and tmpfs mount, then launches clean-copy qualification with
an empty HOME and allowlisted variables. These values come from GitHub's
[documented job service context](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#job-context).
The browser harness starts Django, Python workers and a frontend process whose
environment excludes database/session/provider/storage credentials. No GitHub
workflow success is claimed until the workflow has actually run.
