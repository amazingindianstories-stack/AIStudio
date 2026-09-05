# Veevee cutover architecture

Last reconciled: 2026-09-05. This document describes the release candidate on
`migration/restore-django-cutover`. Production still uses the retained Next.js
deployment until the cutover checklist is approved and executed. For operational
steps and evidence fields, see `docs/django-railway-cutover.md` and
`docs/cutover-go-no-go.md`.

## Runtime ownership

The launch architecture has one browser runtime and one API runtime:

```text
Browser
  └─ Vercel: Vite + React 19 static SPA
       └─ credentials: include → Railway: Django 5 / DRF API
            ├─ Railway PostgreSQL
            ├─ signed GCS upload/read URLs
            ├─ Gemini, Kling, BytePlus and Higgsfield providers
            └─ outbound-polled local GPU depth worker

Railway cron: login-attempt cleanup ─┐
Railway cron: video reconciliation ──┴─ authenticated Django cron endpoints
```

- Browser routes remain `/`, `/login`, and `/admin`.
- API paths and response contracts remain under `/api`; Django is the sole launch
  API and migration authority.
- `VITE_API_URL` is the exact HTTPS Railway API origin embedded at Vite build time.
  `src/lib/api.js` sends `credentials: "include"` for every API request.
- Railway PostgreSQL remains authoritative. Cloud SQL is a post-launch project.
- Direct signed GCS delivery is the launch media path. Cloud CDN is post-launch.
- The depth worker accepts no inbound traffic. It polls, claims, reports progress,
  requests a signed upload URL, and completes jobs over HTTPS.
- The retained Next.js deployment, S3 data, and rollback credentials are rollback
  resources only. They remain untouched through the cutover's seven-day stability
  window.

## Repository map

```text
backend/                 Django settings, eight domain apps, migrations, tests,
                         Railway API/cron definitions and service launcher
src/main.jsx             Vite browser entry and React Router route inventory
src/pages/               Browser route components
src/components/          Studio, canvas, assets, agents and admin UI
src/lib/api.js           Cross-origin API URL and credential contract
src/lib/                 Retained browser/domain helpers and regression tests
src/app/api/             Frozen pre-cutover Next API retained for rollback
depth-worker/            Outbound-polling GPU worker
scripts/                 Legacy migration/probe tools; billed probes require approval
infra/gcp/               Existing GCS migration and storage configuration material
docs/                    Maintained operational and subsystem documentation
```

The release does not delete the rollback API or its server dependencies. The Vite
module-graph guard in `vite.config.mjs` prevents those server, database, provider,
storage, cron, and secret-handling modules from entering browser bundles.

## Frontend

Vercel serves `dist/` as a static SPA. React Router maps the three public browser
routes. No Vercel function or cron is part of the launch runtime.

```bash
npm run dev          # Vite development server; proxies /api to DJANGO_DEV_ORIGIN
npm run lint         # ESLint, zero warnings
npm test             # Vitest
npm run build        # guarded production Vite build
```

A production build requires `VITE_API_URL` to be an exact HTTPS origin with no path,
query, or fragment. `VITE_MEDIA_ORIGIN` defaults to the exact
`https://storage.googleapis.com` origin. The build injects a CSP meta policy containing
only self, the exact API origin, and the exact media origin; the Vercel config contains
no broad `https:` source. Vercel continues to set HSTS, nosniff, frame denial, referrer,
and permissions headers.

Frontend state remains in the established Zustand studio and canvas stores. The
cutover changes transport ownership, not browser response contracts or product flows.

## Django API

`backend/config/urls.py` mounts the domain URL sets under `/api`. The apps are:

| App | Ownership |
|---|---|
| `common` | sessions, users, settings, limits, health, cron auth and origin enforcement |
| `projects` | projects and folders |
| `assets` | reusable project assets |
| `media` | signed upload/read, grants, derivatives, ZIPs and deletion |
| `generation` | image/video/depth generation, queues, history and providers |
| `canvas` | boards, persistence and canvas uploads |
| `agents` | conversations, messages and orchestrated turns |
| `admin_dashboard` | users, pricing, limits, logs, activity and status |

Django uses the existing application tables and becomes migration authority only after
the explicit catalog-adoption window. Adoption migrations preserve historical state and
must never run against production during release preparation.

The browser and Django origins are deliberately separate. Django requires exact,
comma-separated values for `DJANGO_ALLOWED_HOSTS`, `CORS_ALLOWED_ORIGINS`, and
`CSRF_TRUSTED_ORIGINS`. Credentialed CORS is enabled. The HMAC session is a secure,
HTTP-only, host-only, `SameSite=None` cookie. `AUTH_SECRET` and the cookie name remain
compatible with the rollback runtime during the observation window.

Unsafe cross-origin requests are rejected by `TrustedOriginMiddleware` before route
logic. Railway TLS forwarding is trusted only through `X-Forwarded-Proto`; Django's
production security settings enable HSTS, nosniff, and strict referrer handling.

## Data and migrations

Application IDs are UUIDs and application timestamps remain bigint milliseconds for
compatibility. The central `generations` table represents image, video, and depth work;
related tables cover users, projects/folders, assets, settings/limits, pricing, canvas,
agent conversations/messages, activity, login attempts, and depth-worker heartbeats.

The cutover sequence is:

1. Use a read-only production credential for `showmigrations` and `schema_preflight`.
2. Compare the expected table, column, and index catalog with the live catalog.
3. In an approved write window, run `schema_preflight --adopt`, inspect
   `migrate --plan`, run `migrate --noinput`, then require the adopted state.
4. From that point onward, use normal Django migrations only.

Drizzle and the retained Next schema are rollback references, not launch-time migration
authority. Cloud SQL migration and code/schema cleanup are formally deferred.

## Media and storage

The launch backend is GCS. Railway receives a dedicated preview or production service
account through the sealed `GCP_SERVICE_ACCOUNT_JSON` variable; `run-service.sh`
materializes it as a mode-0600 file under `/tmp` at runtime. Preview and production use
different buckets and credentials.

Normal media reads redirect to a signed GCS URL. Acceptance must cover signed upload,
signed read, byte ranges, thumbnails, media delivery, protected-prefix rejection, and
verified deletion. Media bytes must not silently become an API proxy path.

S3 fallback data and credentials are frozen rollback assets. The AWS/GCS observation gate
cannot close before 2026-09-10 and requires a final zero-gap inventory and no-fallback
evidence. No S3 deletion belongs to this release candidate.

## Generation and depth execution

Image and video submission is admitted against user/global limits, persisted, executed,
polled, and terminally settled by Django. Video reconciliation is owned by the Railway
cron only after scheduler transfer. Provider options without evidence stay disabled:
Seedance audio, unsupported Kling seed/2K-reference combinations, and continuation that
does not pass preview acceptance.

Depth jobs use claim tokens and fencing. Launch requires a healthy heartbeat plus `vits`,
`vitb`, and `vitl` jobs through upload, claim, progress, completion, media read, and cleanup.
A deliberate worker termination must demonstrate that the old claim cannot complete the
job, stale recovery resumes it, and terminal cleanup succeeds. Any failure blocks launch.

## Railway services

Three independent services use the definitions under `backend/`:

| Service | Definition | Activation |
|---|---|---|
| API | `railway.json` | deploy to preview; production remains paused until launch |
| login cleanup | `railway.login-cleanup.json` | daily `17 3 * * *` UTC; production paused |
| video reconciliation | `railway.video-reconciliation.json` | every 15 minutes; production paused |

The two cron services share Django configuration but have bounded commands and terminate
after each run. They must not overlap with Vercel cron ownership.

## Verification contract

The local/CI release gate is:

- 419 Django tests on PostgreSQL, `manage.py check`, migration consistency, and route
  inventory parity.
- 787 Vitest cases, ESLint with zero warnings, guarded Vite production build, zero
  TypeScript source files, and `git diff --check`.
- Browser output whose module graph contains no server, database, provider, worker, cron,
  storage-credential, or secret-handling dependency.

Preview acceptance uses disposable identities and fixtures. It covers authentication,
authorization, all product CRUD/read flows, signed GCS operations, queues, reconciliation,
manual cron invocations, and cleanup. Live provider probes have a combined US$2 hard cap
and require separate approval. A core-provider failure blocks launch; an optional feature
failure disables that feature and is recorded.

The signed go/no-go package records the immutable commit, CI and preview deployment IDs,
evidence links, spend, cleanup counts, depth results, production read-only checks, activation
order, rollback commands/triggers, operator names, and seven-day monitoring queries.

## Deferred work and hard stops

The following are explicitly post-launch: Cloud SQL, Cloud CDN, large store/component
refactors, eval-fixture expansion, and invoice reconciliation. Deferral is an architecture
decision for this cutover, not evidence that the findings disappeared.

No production launch, schema adoption, cron activation, traffic move, IAM mutation, secret
creation, GCS write, or billed request occurs implicitly. Release preparation stops at the
documented go/no-go checkpoint, and production launch cannot begin before 2026-09-10.
