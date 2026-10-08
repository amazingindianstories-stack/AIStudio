# Veevee V1 — Django migration implementation blueprint

**Basis:** user-supplied `image-video-project-checkpoint-2026-10-08(2).zip` (checkpoint commit named `89b032298c31a44fee0d2745989f630341bcf181`, plus uncommitted source). This archive has no `.git` history. It is **not evidence that the actual deployed production database or deployed frontend is identical to the archive**.

**Purpose:** precise implementation contract for a single large Codex implementation-and-testing goal, followed by a separately authorized deployment goal. **No deployment, no shared database access, no production migrations, no push/merge to `main`, no cloud-provider/prod calls** during implementation.

## 1. Evidence and position at checkpoint

- Source inventory: **21 Drizzle-owned application tables**, **21 Django model declarations**, **65 Next API route files**, **85 explicitly exported HTTP methods**.
- Current ownership manifest: **0/85 methods Django-authoritative**; **12/85 methods marked `IMPLEMENTING`**, not cut over.
- The Django models under `backend/apps/*/models.py` are currently `managed = False`.
- A separate `backend/baseline_candidate/` graph provides 21 `CreateModel` migrations and one invariant `RunSQL` migration. The checkpoint claims a successful PostgreSQL **16.15** isolated fresh creation, exact source-schema catalog comparison, and no-DDL populated adoption rehearsal (49 existing migration records plus 22 candidate records). Treat these as **reported local evidence**, not production verification; re-run from a clean checkout.
- Generated migration status reports 42 Django regression tests in the checkpoint, and Node suite/build evidence in `qualification-index.md`. This review did not execute those tests.
- The uncommitted Asset Library folder-colour change is already in the ZIP's Drizzle schema and Django model. Its additive migration `scripts/migrate-folder-color.js` installs the `folders_color_check` constraint, but **the existing `.github/workflows/ci.yml` database/browser setup does not list that migration**; qualify integration from a clean checkout.
- `src/middleware.js` has a limited Django method rewrite hook; `src/lib/backend-routing.js` allowlists only five already implemented GET methods. This is migration scaffolding, not a complete route gateway.
- Source still has an existing Node coordinator, the Node export worker and a large Next `/api/queue/execute` route. The coordinator POSTs claimed queued jobs to this Next route, so **provider execution cannot be retired by deleting the persistent worker alone**.
- The source-level deployment runbook and Vercel cron configuration remain anchored to Next/Drizzle and must eventually be replaced, without executing the replacement during the implementation goal.

### Priorities

1. Establish a reproducible, coherent source revision after reconciling the current uncommitted UI work and `89b0322` foundation. Preserve the live working tree and verify the deployed production **commit identity from already authorized release evidence**; no shared target inspection without separate authorization.
2. Build one authoritative Django schema migration graph from the tested baseline candidate and 21 physical-model declarations. Keep existing IDs and semantics, and keep actual production adoption **pending**.
3. Reproduce **every one of 85 method contracts** in Django and qualify them via deterministic, isolated tests.
4. Replace provider execution and all asynchronous Node jobs in Python, then remove Node business APIs, workers and DB/provider packages from the new **source tree**.
5. Package local qualification evidence and a deployment-only playbook. Stop; do not push, deploy or mutate shared resources.

## 2. Locked end-state architecture

```
Browser / Next.js user interface
    |
    | same-origin /api/** (Next/Vercel transparent routing only)
    v
Django + DRF, one source of business truth
    |-- HMAC-compatible sessions, credentials, authorization, limits, CSRF/origin
    |-- projects, folders, assets, portraits, generation, naming, canvas, agents
    |-- queue/admission, exports, media grants, uploads, webhooks, admin
    |-- PostgreSQL (schema entirely controlled by Django migrations)
    |-- signed URLs to GCS/CDN, legacy S3 read fallback if still required
    |
    +--> independent Python generation coordinator and provider executor
    +--> independent Python media-export worker
    +--> Python depth-worker coordination API (external GPU worker stays separate)
    +--> single-sourced scheduled reconciliation jobs
```

Keep Next for its existing UI, pages, assets and optional **transport-only** middleware. No server-side business DB queries, provider calls, token minting or backend data mutation in Next at completion. Do not introduce Celery, Redis, Kafka, Kubernetes, FastAPI or a new media backend without a demonstrated need. Keep PostgreSQL 16 compatibility. Django 5.2/DRF requirements are already pinned in the checkpoint.

**Ownership model:** one Django application owns each physical table; other domains depend on it via explicit relations/services. No table duplication for user/favourites/media/project data merely to look more idiomatic. Treat domain services as the core business API; avoid generic ModelViewSets for concurrency-sensitive mutations.

## 3. Physical model registry — design and invariants

The actual ORM declarations and table names are already in `backend/apps/*/models.py`; retain them unless a grounded source/fixture mismatch is identified. Field lists are in Appendix A below. Primary keys and existing column names must not change, including text PKs and composite PKs. Keep `BigIntegerField` epoch-millisecond semantics; do not switch to auto `DateTimeField`. Keep `JSONField(null=True)` distinct from JSON empty values, and database defaults for inserts from all worker clients. Do not introduce implicit Django FKs where Drizzle stores plain UUIDs.

| Django app / model | SQL table | Domain service responsibility | Dangerous parity obligations |
|---|---|---|---|
| `authentication.User` | `users` | Identity, auth state, role, credentials | **Not** Django `auth_user`; existing scrypt salt/hash, active/auth_version checks, 30-day HMAC session; email unique; don't change IDs/passwords |
| `authentication.LoginAttempt` | `login_attempts` | throttling and cleanup | indexed identifier/time, abuse/rate-limit semantics, privacy |
| `projects.Project` | `projects` | project creation/read, default-project semantics, brief | nullable `created_by` plain UUID; don't add FK/cascade silently; project scoped queries |
| `library.Folder` | `folders` | tree and global/project root, create/rename/move/delete/color | parent/project FKs **RESTRICT**, folder/sibling partial unique indexes, deferred project-scope triggers, versioning, cycle prevention, restricted colours/default `NULL` |
| `library.OrganizationIdempotencyKey` | `organization_idempotency_keys` | request fingerprint and replay receipts | text PK; ownership, operation/payload mismatch 409, advisory locking, transactional atomicity, expiry |
| `library.NamingCounter` | `naming_counters` | stable namespace sequence allocation | text PK, next sequence, concurrency, no repeats |
| `library.GenerationNaming` | `generation_naming` | permanent generation-to-namespace numbering | generation PK/FK **CASCADE**, positive sequence check, `(namespace, sequence)` unique, disambiguation, no reassignment |
| `generation.Generation` | `generations` | central job, library item, provider status, cost, metadata and user-facing history | **60 columns** including JSON refs, draft/audio/video modes, lease/fencing, favouriting, naming-related location version, delayed polling, failed/stale/flagged state; project/folder FKs **RESTRICT**, nullable legacy UUID links preserved |
| `workers.DepthWorker` | `depth_workers` | worker registration, heartbeat and claim identity | worker ID unique, claim UUID + fencing, lease/reap limits, no double completion |
| `assets.Asset` | `assets` | legacy/library asset catalog | `images` JSON default array, project_id plain UUID, slug persistence |
| `assets.PortraitGroup` | `portrait_groups` | BytePlus portrait groups/ownership | nullable unique BytePlus IDs; legacy `project_name`; don't discard orphan/unlisted remote references |
| `assets.PortraitAsset` | `portrait_assets` | character/reference pictures | group FK **CASCADE**; nullable unique BytePlus ID, status semantics, original media URLs |
| `admin_dashboard.Pricing` | `pricing` | model prices/cost units | text model name is PK; don't conflate model cost with retail price |
| `admin_dashboard.AppSetting` | `settings` | current operational settings | text key PK, setting parsing contracts, default/user override resolution |
| `admin_dashboard.UserLimit` | `user_limits` | per-user overrides | **composite PK** `(user_id, key)`; no synthetic ID; value string parsing preserves Node behavior |
| `canvas.CanvasBoard` | `canvas_boards` | board graph and project ownership | JSON graph unchanged, project_id UUID no physical FK, authorization and PUT version semantics |
| `agents.AgentConversation` | `agent_conversations` | chat history/project-scoped mode | agent kind and `kind` legacy defaults preserved; project_id is plain UUID |
| `agents.AgentConversationMessage` | `agent_conversation_messages` | message/tool traces | conversation_id **plain UUID, no physical FK**; preserve role, content, trace, order |
| `common.ActivityLog` | `activity_logs` | audit truthfulness | immutable-ish append semantics, JSON detail, actor UUID nullable; only DB-validated actors in logs |
| `exports.MediaExport` | `media_exports` | draft/final manifest, build state, leases, expiry | manifest version, counts, warnings, output key/bytes, frozen names, retries, invalid transition rejection |
| `exports.MediaExportItem` | `media_export_items` | immutable export membership/order | **composite PK** `(export_id,generation_id)`, export FK **CASCADE**; `generation_id` is plain UUID, filenames frozen at finalization |

### Design clarifications: physical schema vs Django behavior

- Do **not** create Django `auth_user`, auto many-to-many tables, or implicit authentication session tables merely by enabling `django.contrib.auth`. Existing identity is intentionally custom; adding standard Django auth/admin can be a separate authorized feature once mapping is proven.
- Keep existing physical FK policies. `models.RESTRICT` is a Python deletion collector policy, not automatically sufficient proof of the physical PostgreSQL FK's `ON DELETE RESTRICT` behavior. The checkpoint's **scoped custom PostgreSQL schema editor** is part of the baseline proof; preserve and test it.
- Do not add FKs on `projects.created_by`, `generations.user_id`, `generations.source_generation_id`, `assets.project_id`, `portrait_groups.project_id`, `canvas_boards.project_id`, `agent_conversation_messages.conversation_id`, `media_exports.user_id` or `media_export_items.generation_id` solely by assumption. Document and preserve the existing storage contract.
- Two composite primary keys must remain physical composite keys: `user_limits(user_id,key)` and `media_export_items(export_id,generation_id)`. Test Django 5.2 ORM CRUD and raw SQL behavior against them.
- Keep current Unicode normalization/collation and partial unique-index predicates. Do not infer that Python Unicode case/normalization behaves exactly like Node; compare using golden property tests.
- `folders.color` accepts only `NULL` (Default) or **gray, red, orange, yellow, green, blue, purple, pink**. Additive existing-folder adoption defaults `NULL`, not a generated user colour. Color affects icon appearance only, never naming or path identity.
- `Generation` is the job record *and* visible generated library item today; do not create a second replacement Generation/Media table during this migration. Separate provider-specific logic into typed Python request/result adapters and services rather than changing the physical job schema.

### Proposed Python service boundaries (not new physical tables)

```
backend/apps/authentication/services/{sessions,passwords,rate_limits,permissions}.py
backend/apps/projects/services/{projects,default_project}.py
backend/apps/library/services/{folder_engine,organization,idempotency,naming}.py
backend/apps/generation/services/{admission,enqueue,coordinator,status,history,serialization}.py
backend/apps/generation/providers/{gemini,kling,seedance,seedream,omni,magnific,higgsfield}.py
backend/apps/assets/services/{assets,portraits,remote_reconciliation}.py
backend/apps/media/services/{gcs,s3_legacy,media_grants,uploads,transforms,transcription}.py
backend/apps/exports/services/{manifest,claiming,zip_builder,downloads}.py
backend/apps/canvas/services/{boards,uploads}.py
backend/apps/agents/services/{conversations,llm_orchestration}.py
backend/apps/workers/services/{depth_claims,depth_heartbeats,reconciliation}.py
backend/apps/admin_dashboard/services/{pricing,limits,logs,operations}.py
backend/apps/common/{api_errors,request_id,origin,permissions,clock}.py
```

These paths are an implementation outline, not permission to auto-create unnecessary tables. Avoid `Model.save()` signals for critical side effects; use transactional application services.

## 4. Migration-graph consolidation

1. Work from the **current merged source snapshot**, not the previous retired Django branch. Before implementation compare the actual live Git checkout, checkpoint HEAD, working tree, folder-color migration, and `HANDOFF-MANIFEST.json`. Do not reset or discard unrelated UI changes. The ZIP lacks `.git`, so historical Git results in docs cannot be independently rechecked from this archive; Codex should check the live checkout.
2. Freeze the **source-derived** reference catalog, not claim it is live production. The real production catalog remains a later, separately authorized deployment input.
3. Promote **one** authoritative managed Django migration history from the candidate baseline. Do not leave contradictory active unmanaged models and candidate `MIGRATION_MODULES` trees. Reconcile app labels and dependencies, state migration ordering, and existing historical Django migration records.
4. Two modes of qualification:
   - **Fresh create:** run Django migrations in a brand-new disposable PostgreSQL 16 database; compare tables, ordered columns, SQL types, nullability, defaults, checks, PK/FK, index names/predicates, functions, triggers, extensions, sequences, and `django_migrations` bookkeeping against the source-fixture expected catalog.
   - **Populated adoption:** create a disposable current-source database with representative realistic rows and legacy `django_migrations` records, then run a **verified, history-only** baseline adoption. Require zero application DDL and zero application-data changes; reject schema mismatch, missing index/trigger, unexpected history, or different default. Reconnect and repeat, verifying idempotence.
5. Preserve the four hierarchy/naming functions, five triggers and additive FK aliases in frozen versioned SQL with drift checks. Do not silently substitute Django default constraints/index naming/deferrability. Keep existing DB-side constraints until a separate, proven schema alteration.
6. Re-run PG16.15 committed fresh/adoption probes and PG18 scratch checks. Include concurrent transactions, failed claims/lock expiry, and negative control tests. The reported `49 + 22` migration-history rehearsal is an example of possible transitional history, not a declaration of what's in actual production.
7. Production rollout later must independently audit live catalog and migration history, confirm backups/PITR, apply **no-op/history-only adoption** only after verified equivalence, and explicitly verify post-adoption invariants. NEVER run candidate `CreateModel` operations against populated production tables.
8. Do not automatically run migrations in Next/Vercel builds, Django Gunicorn startup or worker startup. Keep a separate migration release operation.

## 5. All 85 API methods: transfer plan

Source-derived group counts from `route-ownership.yaml`:

| Group | Method count | Primary Django owner | High-risk contracts |
|---|---:|---|---|
| admin | 13 | admin_dashboard + common | admin role, CSV pagination, pricing, audit, token bootstrap, old HTTP schema migration retired (not replaced) |
| agent-conversations | 5 | agents | role/agent kind, external LLM calls, tool traces |
| assets incl. portraits | 11 | assets | BytePlus reconciliation, remote persistence, nullable provider IDs, upload/delete |
| audio | 1 | media | transcription and approved external services |
| auth | 5 | authentication | scrypt parity, cookies, CSRF/Origin, session renewal/password invalidation |
| canvas-boards | 5 | canvas | JSON graph, upload, project isolation, payload size |
| cron | 3 | workers/common | exactly one scheduler, idempotence, reconciliation, token |
| folders | 4 | library | hierarchy, version, color, 409 conflicts, atomic moves |
| generate | 8 | generation | queue/provider state, video modes, upscale/depth status, finalize |
| generations/download | 2 | media/generation | GET and HEAD, Content-Disposition, proper filename, redirect/stream semantics |
| history + exports | 11 | generation/library/exports | pagination, move, finalization, immutable export, ZIP download |
| media + media-grant | 2 | media | URL grants, `Range`, signed redirects, large files, provider fetches |
| projects | 2 | projects | default-project creation and empty-state side effects, idempotence |
| queue | 2 | generation | queue status, worker-authenticated execute; remove HTTP execute once Python runs tasks in-process |
| settings | 1 | admin_dashboard | current limit parsing and settings merge |
| uploads | 1 | media | presigned GCS, key/namespace security |
| users | 1 | authentication/admin | safe user listings and access rules |
| webhooks | 1 | generation | signed Seedance callbacks, replay, dedupe |
| worker | 7 | workers/exports | depth claims/progress/complete/upload + export access, token and fencing |
| **Total** | **85** | | |

### Method-by-method implementation workflow

- Use the existing machine-readable `docs/django-migration/api-contract.yaml` for each actual method and source file. For `GET/POST/PATCH/DELETE/PUT/HEAD`, preserve exact old request parsing, repeated query-parameter precedence, types/serialization, status, error JSON, cache headers and cookie behavior. Do not substitute generic DRF pagination/error rendering unless it matches.
- Expand the Django router to all contractual paths, including UUID dynamic segments and the media catch-all, with exact route precedence and no trailing-slash redirects. Keep `/api/*` same-origin to the browser.
- Test **both** authenticated and external clients. Some routes intentionally lack session cookies but require worker bearer credentials, signed media grants, admin bootstrap token, CRON_SECRET or provider callback verification. Do not let a browser cookie gate block legitimate machine clients or let an Origin-less machine bypass authorization.
- For non-JSON flows, qualify streaming/chunked requests, oversized bodies, multipart uploads, signed redirects, Range/HEAD semantics, `Content-Disposition`, ZIP files, conditional requests, provider callbacks, error/timeout behavior and cancellation.
- Even `GET` routes may cause writes (default project creation, read-triggered portrait reconciliation, cookie refresh). Contract tests must compare side effects rather than assuming read-only.
- Create fixture-rich parity tests against current Node implementation **locally only**, with isolated DBs, mock AI providers and fake storage. Cache/store golden responses with authorization and failure cases, not live production user data.
- Treat method + route as acceptance units. A route is `IMPLEMENTED_TESTED_LOCAL` only with a passing contract test, and `DJANGO_AUTHORITATIVE` only **after a separate authorized production cutover**. In the implementation-only source tree, replace production-traffic states with honest code-completion states, not fabricated production ownership.

### Implementation workstreams in one continuous Codex goal

1. **Foundations/auth/reads** — complete the 12 started methods, all auth methods, settings, projects, folders, assets/history/counts/updates and canvas reads; preserve 30-day HMAC sessions and Node password equivalence.
2. **Project/library writes** — project POST; folders POST/PATCH/DELETE including color; history move/favorite/flag/delete; assets/portrait CRUD; naming, idempotency and conflict mapping.
3. **Canvas/agents/admin** — board CRUD/graph/media upload, conversations/messages/LLM, all admin methods, operation audit and token bootstrap; consciously decommission HTTP schema mutation.
4. **Storage/audio/downloads** — current GCS primary, legacy S3 read fallback, signed grants, presigned uploads, transcoding/thumbnail compatibility, audio transcribe; avoid returning private storage keys and avoid full media proxy through Gunicorn when signed direct delivery works.
5. **Exports** — create/add/finalize/status/download, manifest version 2, frozen filenames, private grant access; Python ZIP worker.
6. **Generation** — submit/admission/poll/status/finalize/upscale/video/depth, provider adapter payload/response parity, Python coordinator/executor, request retries/leases/timeout semantics and provider webhook flow.
7. **Depth and scheduled jobs** — worker registration/claim/progress/heartbeat/upload-url/complete, lease fencing, reconciliation, schedule exactly-once claim semantics; keep local GPU process external.
8. **Full backend elimination** — remove Next business routes, Next DB/provider/worker code and packages; leave Next only UI/static and request forwarding. Switch all frontend and browser tests to Django-backed local API. Re-run exhaustive CI.

Use Codex subagents/workstreams when beneficial, but require one owner for shared migration files, source inventories and routing; run integration gates serially for each dependency. Do not fork a second long-lived Django implementation.

## 6. Generation and worker decomposition (critical path)

**Current special hazard:** `src/worker/generation-worker.js` claims due jobs and POSTs them to `/api/queue/execute`, whose Next route is a large provider execution path. The Node job is not a pure background Python-equivalent coordinator. Inventory the full call graph first: submit, admission, actual provider work, callback, poll/advance, media import, finalization, release, heartbeat, retries, user charging and realtime notifications.

Target split:

- `GenerationAdmissionService`: validate user, scope, quotas, model, character refs, motion refs, URL grants; durable enqueue with idempotency.
- `GenerationCoordinator`: row-level claims, queue fairness/concurrency, lease/fencing, due work and recovery.
- `GenerationExecutor`: Python provider adapters called directly from a worker process; never outsource execution to removed Next `queue/execute`.
- `GenerationPoller`: provider statuses, scheduled retries, stale task and callback reconciliation.
- `GenerationFinalizer`: storage integrity, output type/native bytes, poster, cost-basis, timestamps, status/event audit and single-winner completion.
- `DepthCoordinationService`: external GPU worker contract and claim/heartbeat/progress/fencing; GPU pipeline does **not** run inside Django Gunicorn.
- `MediaExportWorker`: separate Python process to claim, build ZIP, upload, grant and clean up.

**Provider matrix (seven reported adapter modules):** `gemini`, `kling`, `seedance`, `seedream`, `omni`, `magnific`, `higgsfield-mcp`. Also inventory helper execution (upscale, depth, audio transcription, LLM, FFmpeg/media transforms); seven provider modules are not the whole integration surface. For each record input modes, transport/auth, sync vs async, shape, headers, callback verification, retry policy, cancellation, output MIME/codec, billing and observability. Port from **current Node source and tests**, using historical Django only if equivalence is demonstrated.

Special product invariants:

- Seedance Generate/Edit/Extend/Draft/draft-to-final must preserve **correct mode** and character/motion references without mistakenly interpreting generate mode as edit.
- For Seedance 2.5, request native MOV `output_format: "mov"` and preserve original media bytes, Final/High defaults and explicit user quality choices. No MP4-renamed-as-MOV or silent recompression.
- Canonical direct-download names equal finalized ZIP entry names; frozen manifests never rename retroactively after hierarchy changes; collisions and Unicode folding must match Node production.
- Portrait BytePlus references and remote groups must not vanish due to local DB omissions; inventory/list reconciliation needs both legacy and new state semantics.
- Avoid duplicate provider submissions and double charging under crash/retry/callback concurrency.

Offline test matrix: provider request golden JSON, edit/generate motion-ref precedence, BytePlus character refs, provider response parsers, auth/timeouts, JSON error classification, polling, cancellation, storage output, live-job idempotency simulation, crash recovery, exact ZIP path/content, FFmpeg-native output handling where fixtures allow. **Do not claim live-provider compatibility from mocks**; preserve specific deployment acceptance tests for a later authorized run.

## 7. Retirement strategy in the implementation branch

This is a single continuous implementation goal, but retire modules **after their replacement and regression tests pass**, in dependency order. Remove source implementations without deploying them.

| Legacy surface | Replacement | Retirement gate |
|---|---|---|
| `src/app/api/**/route.js` (65) | Django URL + DRF view/service equivalent (or explicitly retired admin migration endpoint) | all 85 explicit method contracts/negative cases passing; no frontend call hits removed Next handler |
| `src/app/api/queue/execute/route.js` | Python `GenerationExecutor` called by coordinator | provider/queue/admission/crash/fencing contract passing; no Node worker posts to old endpoint |
| `src/worker/generation-worker.js` | independent Python coordinator/executor | worker scheduling, claiming, leases, retries, status, all adapters locally qualified |
| `src/worker/media-export-worker.js` | Python media export worker | ZIP manifests, hashes, stability, retries, GCS mocks qualified |
| `src/lib/store*.js`, DB access and business services | Django ORM/services | frontend/server-import closure proves no legitimate Next dependencies |
| `src/lib/providers/*`, Node media/auth helpers | Python provider/auth/media services | fixtures and error behavior passed; no Python code shells out to Node for business logic |
| `src/lib/schema.js`, Drizzle migrations and `drizzle-kit push` | Django managed migration graph | fresh-DB plus populated-adoption rehearsal, schema catalog and future migration CI pass; evidence archived, not blindly deleted |
| `src/app/api/admin/migrate-schema/route.js` | controlled offline Django release operation | intentional endpoint decommission + no frontend/admin dependency; no HTTP equivalent |
| `vercel.json` backend crons | one planned Django scheduler/cron caller | schedule identity, credentials, fencing, no double invocations documented for deployment; leave production config untouched now |
| backend secrets in Vercel | Railway Django + worker secret boundary | audit of source requirements and documented cutover; do not modify live env now |
| Next middleware routing/cookie presence UX | Next transport-only request proxy + Django full auth | same-origin integration tests, machine client auth tests, proxy-error fail closed |

**Do not mechanically delete all `src/lib` or Next middleware.** Build a reachable import graph from Next pages/components/layout/Next config/middleware and identify any server components/actions that still perform DB/provider operations. Preserve UI helpers and client-safe pure code. Eliminate hidden Node backend behavior even if it lives outside `/api`.

**Completion statuses must be honest:** In this no-deployment run, method/runtime ownership is `DJANGO_IMPLEMENTED_LOCAL`, not `DJANGO_AUTHORITATIVE_PRODUCTION`. Keep a separate `desired_owner` or `release_plan` if the existing guard's schema only allows production states. Do not falsify production route-ownership manifest just to make percentages look 100%.

## 8. Tests and acceptance gates

### A. Static invariants

- 21 physical models and complete current source schema mapping; 60-generation-column coverage; `makemigrations --check --dry-run` clean; no unplanned schema change.
- No `src/app/api` business handlers and no Node provider/worker executors in migrated branch; no Next imports of DB/provider/secret modules.
- All **85 explicit HTTP methods** backed by Django routes or an intentional documented retirement (HTTP schema migration endpoint). Include implicit HEAD/OPTIONS/redirect semantics where Next previously provided them.
- Route contracts, model tests, source/contract manifest and ownership status machine-verifiable.

### B. Database correctness

- Fresh PG16 migrations and full catalog equivalence, with Django bookkeeping compared.
- Existing-history populated adoption zero application DDL/data change, including adverse migration-history and catalog drift cases.
- Controlled multi-transaction tests of FKs/RESTRICT/CASCADE, partial unique collisions, Unicode names, project/global folder scoping, trigger-deferred scope, cycle prevention, idempotency, concurrent naming and atomic batch moves.
- MediaExportItem/UserLimit composite CRUD and Generation 60-column image/video/depth ORM roundtrips.
- No accidental reuse/reassignment of identity, naming sequences, export filenames, media keys, user passwords or ownership.

### C. HTTP/security

- Each method status, payload, error shape, auth/role, headers and DB/storage side effects compared with Node golden behavior on **isolated fixtures**.
- Confirm cookies: HttpOnly, Secure in deployed-mode simulation, SameSite, 30-day expiry, rolling refresh, logout, authVersion bump, throttling, scrypt Unicode and wrong-password timing handling.
- Same-origin reverse proxy: all HTTP methods, path segments, encoded media paths, query strings, forwarded Host/Origin, size/range/cookie/Set-Cookie, route precedence, TLS-origin allowlist; fail closed on routing misconfig. Explicitly reject open proxy/SSRF and untrusted forwarded-header impersonation.
- External secret/bearer pathways: worker depth, worker exports, generation coordinator, cron, admin bootstrap, signed media grants, signed Seedance callbacks; no reliance on browser session where none exists.

### D. Browser/UI regressions

- Entire existing Playwright suite runs against local Django (not silently falling back to Node).
- Asset library: workspace/project switch, folder tree & breadcrumbs, collapsed folder strip, palette 8+Default, persisted colours, marquee, keyboard/multiselect, drag/drop, contextual selection actions, favourites, ZIP export.
- Portrait persistence/remote reconciliation, Canvas, chat/agents, upload and media previews.
- Seedance motion/video reference and character-image generate/edit flows.

### E. Worker/media/provider

- Queue fairness and admission, single-winner leased claim, crash/restart, lease expiry, retries/backoff, callback-vs-poll race, provider idempotency, cancellation; exact generation status and cost persistence.
- ZIP entry list/file hashes/name stability and manifest v2, retries, corrupted/expired objects, TTL, negative grants.
- GCS signed URL and large media behavior under local mock; legacy S3 read fallback where applicable; authenticated upload/object namespace checks; sensitive signed query URLs absent from logs.
- Provider request/output fixture equivalence; **live provider and media service acceptance reserved for a separate authorized deployment qualification**.

### F. Quality and evidence

- `pytest`/Django tests, Django system checks, schema migration graph, Node frontend unit tests/lint/build, PostgreSQL DB fixture suite, all browser integration, dedicated Python worker test suite, zip no-secret scanner.
- Each stage produces a reproducible command, version, test counts, artifact/failure notes. No cosmetic PASS marks for skipped categories.
- Local code should fail safely on missing external service config; never use production environment variables for tests, and never infer safety from an environment name.

## 9. One-goal execution schedule / dependency gates (not time estimates)

```
G0  snapshot/reconcile worktree + checkpoint manifests; production isolation
G1  model registry / ORM + executable baseline unification + PG16 fresh/adopt tests
G2  common response/auth/media/security primitives + fully runnable Django harness
G3  85 HTTP methods, grouped by independent domains, with contract tests
G4  generation/provider Python services + deep queue/worker qualification
G5  export worker + storage + depth/callback/scheduler qualification
G6  switch local browser/worker integration to ONLY Django API, no hidden Node fallback
G7  remove Node routes, DB/provider code, legacy workers, Drizzle authority from NEW source
G8  complete regression suite, schema equivalence, performance and security gates
G9  package report, source artifact, retention/recovery plan and deployment-only runbook
STOP: no deployment, migration of shared target, push, merge or production credentials
```

Within G3–G5, parallel implementations may be used **only** against stable service contracts and independently owned files; route registry/schema migration files and integration state must have one owner to prevent merge races.

## 10. Practical blockers to resolve before writing the final Codex goal

1. **Production vs snapshot identity**: actual deployed Vercel revision / PostgreSQL catalog not verified from this ZIP; no authority transfer until later live audit.
2. **Dirty folder-colour work**: reconcile uncommitted change with `src/lib/schema.js`, `scripts/migrate-folder-color.js`, CI, verifier, migrations and Django baseline. Test from clean checkout. Existing Drizzle CI does not explicitly apply folder-colour migration.
3. **Two Django migration modes**: current models `managed=False`; candidate baseline separate. Consolidate to one coherent future managed graph, with clearly isolated dry-run adoption logic. Do not accidentally apply CreateModel to existing tables.
4. **Historical `django_migrations`**: rehearsal includes pre-existing records; production could differ. Build reject-by-default audited adoption, no blind `--fake-initial`.
5. **Generation worker hidden Next dependency**: worker POSTs Next `/api/queue/execute`. The final Python process must execute providers itself. Test local worker without Next business route.
6. **Routing only implements 5 GET method switches**: expand to all 85 with exact method/path matching or simplify to a single eventual all-Django `/api` proxy after local retirement. Do not confuse implementation mode with production route switch.
7. **Existing `vercel.json` crons**: plan one scheduler owner and transition protocol, no duplicate scheduled work or missing reconciler.
8. **Current Next backend dependency closure**: one 3k-line `store.js` and many server-side helpers might be imported indirectly. Verify import graph before deleting.
9. **Hosted/prod-only compatibility**: signed GCS/IAM, BytePlus provider fetch, webhook routing and live provider output codecs cannot be fully verified offline. Ship deployment qualification plan with explicit pending states.
10. **No production access**: no active production DB/hosting credentials in the implementation runner; never request them for local tests. Existing deployment/runbook may be historical; verify active config only later with authorization.

## 11. Outputs Codex must deliver after the large implementation run

- Repository code in a **non-deployed migration branch / local working tree**: fully implemented Django and Python workers, Next UI, no Node business backend; all current user changes retained.
- Final `model-registry.md` matching all 21 SQL tables/field definitions and exact constraints; architecture/service boundaries and no unnecessary new tables.
- Authoritative Django migration graph and isolated fresh/adoption evidence; live production adoption explicitly pending.
- Final 85-method contract coverage matrix plus local test evidence; describe intentionally removed HTTP schema-migration endpoint separately.
- Provider parity matrix for seven adapters + auxiliary audio/LLM/FFmpeg/depth paths, with local pass and live pending marked distinctly.
- Independent export and generation Python worker qualification; no remote AI request was used to inflate PASS.
- Next retirement/import graph report and CI gate proving browser UI uses Django for every API call.
- Updated operational docs/AGENTS/CLAUDE/runbook and **one proposed deployment/cutover sequence (UNEXECUTED)**.
- A secrets-sanitized ZIP including source and complete logs/results, plus final local commit/diff status and reproducibility commands.
- Clear remaining limitations/blockers. Do not mark `DJANGO_AUTHORITATIVE_PRODUCTION` until later approved deployment and traffic verification.

---

## Appendix A. Exact physical Django model field inventories in checkpoint

The following fields were extracted directly from the archive's `backend/apps/*/models.py`. `pk` in composite-key classes is a virtual `CompositePrimaryKey` definition, **not an additional physical database column**. `project`, `folder`, `parent`, `group`, `export`, and `generation` are Django relation attribute names mapped to SQL `_id` columns via explicit `db_column`.

### `admin_dashboard.Pricing` — `pricing` (4 SQL fields)

`model, unit_cost_cents, unit, notes`

### `admin_dashboard.AppSetting` — `settings` (3 SQL fields)

`key, value, updated_at`

### `admin_dashboard.UserLimit` — `user_limits` (4 SQL fields)

`pk, user_id, key, value, updated_at`

### `agents.AgentConversation` — `agent_conversations` (8 SQL fields)

`id, project_id, name, kind, agent_kind, created_by, created_at, updated_at`

### `agents.AgentConversationMessage` — `agent_conversation_messages` (6 SQL fields)

`id, conversation_id, role, content, tool_trace, created_at`

### `assets.Asset` — `assets` (9 SQL fields)

`id, kind, name, slug, description, images, project_id, created_at, updated_at`

### `assets.PortraitGroup` — `portrait_groups` (10 SQL fields)

`id, byteplus_group_id, name, description, group_type, project_name, primary_asset_id, project_id, created_at, updated_at`

### `assets.PortraitAsset` — `portrait_assets` (11 SQL fields)

`id, group, byteplus_asset_id, name, asset_type, role, image_url, status, status_message, created_at, updated_at`

### `authentication.User` — `users` (11 SQL fields)

`id, email, password_hash, password_salt, created_at, name, role, color, avatar_url, is_active, auth_version`

### `authentication.LoginAttempt` — `login_attempts` (3 SQL fields)

`id, identifier, created_at`

### `canvas.CanvasBoard` — `canvas_boards` (7 SQL fields)

`id, project_id, name, data, created_by, created_at, updated_at`

### `common.ActivityLog` — `activity_logs` (5 SQL fields)

`id, user_id, action, detail, created_at`

### `exports.MediaExport` — `media_exports` (17 SQL fields)

`id, user_id, status, total_items, processed_items, skipped_items, warnings, attempt_count, lease_owner, lease_until, output_key, output_bytes, error, manifest_version, created_at, updated_at, expires_at`

### `exports.MediaExportItem` — `media_export_items` (5 SQL fields)

`pk, export, generation_id, position, source_key, filename`

### `generation.Generation` — `generations` (60 SQL fields)

`id, kind, status, prompt, model, aspect_ratio, resolution, duration, url, poster, error, provider_responses, moderation_blocked, reference_images, reference_videos, reference_audios, project, folder, user_id, cost_cents, cost_basis, is_favorite, favorited_at, task_id, source_generation_id, draft_task_id, submitted_at, provider_created_at, provider_updated_at, completed_at, last_poll_at, next_poll_at, poll_attempts, callback_received_at, provider_status, worker_lease_id, worker_lease_until, poll_error_count, last_poll_error_at, generate_audio, draft_mode, bitrate_mode, video_task_mode, progress_percent, progress_message, track_characters, depth_claim_id, depth_claim_worker_id, depth_reap_attempts, seed, candidate_task_ids, continuation_frame_url, last_frame_url, flagged, flagged_at, flag_reason, judge_score, location_version, created_at, updated_at`

### `library.Folder` — `folders` (9 SQL fields)

`id, project, parent, name, name_normalized, version, color, created_at, updated_at`

### `library.OrganizationIdempotencyKey` — `organization_idempotency_keys` (8 SQL fields)

`key, actor_id, operation, fingerprint, status, result, created_at, expires_at`

### `library.NamingCounter` — `naming_counters` (3 SQL fields)

`namespace, next_sequence, updated_at`

### `library.GenerationNaming` — `generation_naming` (4 SQL fields)

`generation, namespace, sequence, assigned_at`

### `projects.Project` — `projects` (6 SQL fields)

`id, name, brief, created_by, created_at, updated_at`

### `workers.DepthWorker` — `depth_workers` (12 SQL fields)

`id, worker_id, label, device, status, current_job_id, current_claim_id, protocol_version, ram_limit_mb, ram_used_mb, last_seen_at, created_at`

