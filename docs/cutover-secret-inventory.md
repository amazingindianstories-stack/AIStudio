# Cutover secret inventory (names only)

Captured: 2026-09-05; preview inventory refreshed 2026-09-07. Values, object names, credential identifiers, and key material
are intentionally omitted. This record describes presence and required disposition;
it is not permission to copy or delete a value.

## Vercel current state

The linked `aistudio-v1` project still hosts the production Next API and therefore
contains legacy server-runtime configuration. The 2026-09-05 name-only inventory found
these categories:

- Database: `DATABASE_URL`, `DATABASE_BACKEND`, `DB_NAME`, pool/connect/idle tuning,
  Cloud SQL connection and IAM flags.
- Provider: Google/Gemini, Kling, BytePlus/Ark, Seedance, and Higgsfield MCP names.
- Worker/cron/setup: `DEPTH_WORKER_TOKEN`, `CRON_SECRET`, `SET_TOKEN_SECRET`.
- Storage/private runtime: AWS access/bucket names, GCS bucket/project/auth/WIF names,
  migration fallback and media-backend flags.
- Other server generation/runtime tuning names.

This fails the frontend-only Vercel gate by design while the Next API remains current
production and rollback. Do not remove these names during preparation. After the Vite
traffic flip and its seven-day stability window, prove the retained Next rollback is no
longer required, then remove server-only values in one separately approved cleanup.

The cutover Vite deployment should retain only public browser build configuration:

- `VITE_API_URL`
- `VITE_MEDIA_ORIGIN`
- `VITE_REF_MAX_DIM` if the non-default value is required

No secret may use a `VITE_` prefix.

## Railway target inventory

Record presence by service/environment without values. The API needs the complete
runtime set. Cron services should receive the minimum their command/import graph needs;
begin from the shared set only when Railway cannot scope shared references more narrowly.

| Name/category | Preview API | Preview cleanup | Preview reconcile | Production API | Production cleanup | Production reconcile |
|---|---|---|---|---|---|---|
| `DATABASE_URL` | Present | Present | Present | Service absent | Service absent | Service absent |
| `DJANGO_SECRET_KEY` | Present | Present | Present | Service absent | Service absent | Service absent |
| `AUTH_SECRET` | Present | Present | Present | Service absent | Service absent | Service absent |
| allowed host/CORS/CSRF names | Present | Hosts only | Hosts only | Service absent | Service absent | Service absent |
| `CRON_SECRET` | Present | Present | Present | Service absent | Service absent | Service absent |
| `SET_TOKEN_SECRET` | Present | Absent | Absent | Service absent | Service absent | Service absent |
| `DEPTH_WORKER_TOKEN` | Present | Absent | Absent | Service absent | Service absent | Service absent |
| media/GCP non-secret names | Present | Present | Present | Service absent | Service absent | Service absent |
| `GCP_SERVICE_ACCOUNT_JSON` sealed | Present; sealing not rechecked | Not needed | Present; sealing not rechecked | Service absent | Service absent | Service absent |
| enabled provider credential names | Absent | Not needed | Absent | Service absent | Service absent | Service absent |

## Isolation rules

- Preview uses a disposable PostgreSQL database, dedicated GCS bucket, and dedicated
  bucket-scoped service account. It never references production database or media.
- Railway does not implicitly inherit sealed variables into preview; verify each name.
- Production service values may be prepared with deploys skipped, but production API
  deployment and cron schedules stay paused until the approved launch sequence.
- Never use CLI JSON/KV variable-list output in shared logs because it includes raw
  values. Record names manually from the platform's redacted view.

## September 7 verified preview inventory and remaining blockers

The September 5 Railway/GCP provisioning blockers are superseded: `cutover-preview`
exists, API deployment succeeds, and a disposable object passed signed GCS upload,
direct range read, and verified deletion in the dedicated preview bucket.

Name-only inspection through the selected preview service environments found:

- API: database, Django/auth secrets, allowed-host/CORS/CSRF names, cron/setup/depth
  tokens, GCS project/bucket/backend configuration, and service-account JSON present.
- Login cleanup: database, Django/auth/cron secrets, allowed hosts, GCS
  project/bucket/backend names present. No GCS credential is needed for login cleanup.
- Video reconciliation: the cleanup set plus GCS service-account JSON present.
- Enabled provider credentials: **absent** from API and reconciliation preview
  environments (Google/Gemini, Kling, Ark/BytePlus, Higgsfield categories inspected).
  No live provider readiness is claimed.
- Production: only PostgreSQL currently exists in this Railway project; API/cron
  configuration and credential inventory remain pending the agreed release gate.

Both preview cron schedules are now paused in `.railway/railway.ts`; their acceptance
runs are explicit. Production schedules were not changed. Vercel legacy environment
values remain in place for the current Next runtime and rollback window.

Browser acceptance remains limited by Vercel sign-in protection. GCS IAM least-privilege
review and full provider/depth acceptance still require evidence even though the tested
storage transport operations pass. See [release evidence](UX_Cutover_Preview_2026-09-07.md).
