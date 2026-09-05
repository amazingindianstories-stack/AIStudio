# Cutover secret inventory (names only)

Captured: 2026-09-05. Values, object names, credential identifiers, and key material
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
| `DATABASE_URL` |  |  |  |  |  |  |
| `DJANGO_SECRET_KEY` |  |  |  |  |  |  |
| `AUTH_SECRET` |  |  |  |  |  |  |
| allowed host/CORS/CSRF names |  |  |  |  |  |  |
| `CRON_SECRET` |  |  |  |  |  |  |
| `SET_TOKEN_SECRET` |  |  |  |  |  |  |
| `DEPTH_WORKER_TOKEN` |  |  |  |  |  |  |
| media/GCP non-secret names |  |  |  |  |  |  |
| `GCP_SERVICE_ACCOUNT_JSON` sealed |  |  |  |  |  |  |
| enabled provider credential names |  |  |  |  |  |  |

## Isolation rules

- Preview uses a disposable PostgreSQL database, dedicated GCS bucket, and dedicated
  bucket-scoped service account. It never references production database or media.
- Railway does not implicitly inherit sealed variables into preview; verify each name.
- Production service values may be prepared with deploys skipped, but production API
  deployment and cron schedules stay paused until the approved launch sequence.
- Never use CLI JSON/KV variable-list output in shared logs because it includes raw
  values. Record names manually from the platform's redacted view.

## Current blockers

- Railway project `balanced-acceptance` was identified, with only its production
  PostgreSQL service present. Creating `cutover-preview` from the production topology
  was attempted, but Railway rejected it because the account trial has expired. A
  follow-up environment listing confirmed that no preview environment or service was
  created. A Railway plan must be selected before preview provisioning can continue.
- GCP CLI required interactive reauthentication before it could even list buckets;
  consequently no preview bucket, service account, IAM grant, credential, or GCS write
  was created.
- Vercel cleanup is deliberately blocked until the current Next runtime no longer owns
  production/rollback.
