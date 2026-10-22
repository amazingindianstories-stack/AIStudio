# Automatic portraits (managed BytePlus pool) - rollout and rollback

Status 2026-10-16: v1 (2026-10-14) plus **Portrait Gallery v2** are implemented and verified **locally only**.
Nothing is deployed. Every production step below needs explicit owner approval.

## What changes for artists
- A video reference that contains a face (local YuNet detector, fails closed) is registered as a
  BytePlus asset automatically and submitted as `asset://…`. Plain images stay inline.
- Identical images share one asset (content SHA-256). Assets in use by a queued/running generation
  are pinned and never expired or evicted. Unused assets expire after `portraitAssetTtlHours` (4).
- When the pool is full the least recently used unpinned asset is evicted; if everything is pinned
  the job waits (`PORTRAIT_WAITING`, card shows the reason) up to `portraitQueueWaitMinutes` (15),
  then fails **without any paid submission**.
- ACTIVE assets are re-confirmed with BytePlus (unbilled GetAsset) at most 60 s before a submission,
  and after any failed job; a vanished asset is registered again automatically.
- The Portrait Gallery (v2) is one shared, flat grid: artists upload one or many images (they are
  prompt-ready after a short preparation), rename, delete (anyone may delete), select several and add them to
  a prompt. Faces found automatically in prompt references appear there while their asset is live and
  disappear when it expires or is deleted. Uploads are pool assets too: unused ones expire after the TTL.
  Users never see groups, asset ids, slots or the word BytePlus. The old manual portrait routes
  (`/api/assets/portraits*`) answer 410 `PORTRAITS_ARE_AUTOMATIC` on every method.
- Pool slots are handed out strictly first come first served: the oldest waiting generation or queued
  upload gets the next free (or evictable) slot; everyone else waits behind it.
- A face the detector misses never traps an artist: when Seedance refuses an inline reference as a real
  person (at creation or asynchronously), the image bytes are remembered as a face and the failure says so;
  **Retry** then registers it and sends `asset://`. There is no automatic resubmission (the paid claim stays
  one-shot). Uploading the same image to the Gallery has the same effect.
- A slot waiter's place in line is when it started waiting for a slot (not for processing); the overall
  wait limit still counts from its first wait. No second eviction starts while an earlier delete is
  unresolved (DELETING or UNCERTAIN), so a failing DeleteAsset cannot empty the pool.
- When BytePlus reports a full quota the pool takes what it had accepted as its size (0 when the quota is
  used elsewhere) and starts no registration for 60 s; after that one registration probes again.
- Processing is timed from the start of registration (3 minutes), not from the upload. A timed-out or failed
  asset that a generation still pins is not deleted: that generation fails (not charged) and the asset is
  deleted once nothing holds it.
- Old references (a `#bp_asset_id=` marker on an image) are pooled by their bytes and never checked at
  BytePlus; a bare `asset://` link is refused at enqueue ("@imgN is an old portrait link that no longer exists").
- The detector can take a non-human image (an animal, a sketch, tiny figures) for a face. When BytePlus
  definitively refuses to register such an image (4xx, not quota) the image is remembered as
  `provider_refused_asset` and the generation continues with it inline. Faces from Gallery uploads or learned
  from a Seedance rejection keep failing clearly. A Seedance privacy rejection cannot turn a refused image back
  into a face (no ping-pong; its failure shows the usual face copy without a Retry promise); only an explicit
  Gallery upload of the same image does.
- Admin → Limits → Portrait storage: TTL hours (1–72), pool size, longest wait.

## Pieces
| Piece | Where |
|---|---|
| Migration 0005 (5 new tables, grants to existing roles) | `apps/assets/migrations/0005_managed_portraits.py` |
| Migration 0006 (additive columns: asset `name`, `origin`, `hidden_at`, QUEUED status; scan `forced`) | `apps/assets/migrations/0006_portrait_gallery.py` |
| Pool (adopts the group `veevee-portraits` by name), first-come-first-served claim, janitor, upload processing | `apps/assets/managed_pool.py` |
| Gallery API | `apps/assets/managed_views.py` |
| Missed-face learning | `portrait_prepare.learn_from_rejection`, called from `executor.execute_admitted` and `poller` |
| One-off cleanup of the old BytePlus portraits | `python manage.py portraits_cutover` |
| Worker preparation before admission | `apps/generation/services/portrait_prepare.py`, `executor._prepare_portraits` |
| Scheduler: janitor (60 s) and upload/delete processing (3 s, one upload at a time) | `apps/workers/scheduler.py` (only when the flag is on) |
| Routes | `GET/POST /api/portraits`, `PATCH /api/portraits/<id>`, `POST /api/portraits/delete`, `GET/POST /api/admin/portrait-settings` (all pass the gateway's general rule; Django enforces sessions and admin) |
| Flag | `VEEVEE_MANAGED_PORTRAITS=1` (default off). The launcher passes it to API, generation and scheduler only |
| Worker credentials | generation + scheduler need `GOAL4_PREVIEW_PORTRAIT_CONFIGURATION` (same value as the API's); with the flag on and no credentials they refuse to start |
| Rollback | `python manage.py managed_portraits_rollback` (also deletes the pool group) |

## Preconditions (all required)
1. Release gate **and** rehearsal pass records for the exact commit
   (`scripts/release/release_gate.sh`, `rehearse_local.sh` - the rehearsal applies the
   migration as the owner and runs the pool with the real database roles).
2. The generation worker is on the versioned image (done 2026-10-15, `a3b5d12`).
3. Owner decision on the existing remote assets (59 Active + 51 archived): the pool needs free
   BytePlus slots (`QuotaSharedPoolExceeded` since 2026-10-13 18:21 IST). The approved plan is to
   clean them at rollout together with the old internal portrait state.
4. An idle moment (no queued/running jobs).

## Rollout order
1. Deploy the new image to every service with the flag **off** (behaviour identical to today; the old
   portrait routes keep working). Check the launcher preflight accepts 60, 61 and 62 migration rows
   (`MIGRATION_ROWS` in `backend/deploy/legacy_config.py`).
2. **Migration** (owner DSN, one-off): `python manage.py migrate --noinput` → `django_migrations`
   goes 60 → 62 (`assets.0005_managed_portraits`, `assets.0006_portrait_gallery`; 0006 only adds
   columns). From here the **old launchers cannot start** (they assert 60 rows). Rolling a service back
   to an old launcher now requires the rollback below first.
3. Add `GOAL4_PREVIEW_PORTRAIT_CONFIGURATION` to the generation worker and scheduler (reference
   the API's variable; never printed).
4. **Clean the old BytePlus portraits** (owner decision 2026-10-16: the old gallery starts empty):
   `python manage.py portraits_cutover` (dry run, default) lists every AIGC group and asset in the account
   except the pool group and prints the counts and per-group asset counts (it names ids: run it privately).
   The owner reviews the counts, then
   `python manage.py portraits_cutover --apply --expect-assets N --expect-groups M` (N, M from the dry
   run; it refuses on any difference, deletes every asset then every group, treats NotFound as done, then
   marks every `portrait_assets` row `Retired`, keeping the rows because old generations and media grants
   refer to their image URLs). Safe to re-run; it never touches the pool group, ignores groups whose Status is
   Deleted, and never deletes an asset whose group is missing or not listed (it reports those by id).
5. Set `VEEVEE_MANAGED_PORTRAITS=1` on API, generation worker and scheduler; redeploy API → generation
   (idle) → scheduler. With the flag on, the old portrait lifecycle (`apps/assets/portrait_lifecycle.enabled()`)
   stays off and `enqueue` skips the old portrait reference check.
6. Deploy the frontend (Portrait Gallery v2) with the Vercel CLI.
6a. Concurrency: 8 running jobs per user (`admission.PER_USER_MAX`; production `settings.maxConcurrentJobs` = 8
   since 2026-10-17) and 8 running videos overall (`MAX_CONCURRENT['video']`). BytePlus runs at most 3 tasks per
   Seedance model on an Individual account (10 Enterprise) and silently queues the rest, so admission also caps
   each BytePlus Seedance model (2.5, 2.0, 2.0 fast) at Admin -> Limits -> "Seedance tasks per model" (default 3).
   Jobs over it stay queued here, first come first served, with "Waiting for a free <model> slot" on the card.
7. Verify: startup logs pass preflight; `GET /api/portraits` → `enabled: true`; the old routes answer
   410; one owner-approved Seedance face job (paid canary) → asset ACTIVE, `asset://` in the receipt,
   MOV master; a Gallery upload goes waiting/preparing → ready; janitor and upload steps run (scheduler
   log); the admin portrait-storage card renders.

## Rollback
- **Flag only** (fast, keeps the schema): set `VEEVEE_MANAGED_PORTRAITS=0` (or remove it) on the
  three services and redeploy. Face references go inline again as before, and the composer's attachment
  menu hides Portrait Gallery (it follows `enabled` from `GET /api/portraits`). The old portraits **cannot
  come back**: the cutover deleted them at BytePlus (their rows stay as `Retired`).
- **To an old launcher** (needs the 60-row history):
  1. Flag off on every service (above); wait until no queued/running generation holds a pin (the command
     itself releases pins of finished or deleted generations and uploads' own pins, and reports them).
  2. Report: `python manage.py managed_portraits_rollback` (owner DSN, flag off in that process).
  3. `python manage.py managed_portraits_rollback --delete-remote --confirm` - deletes every asset in
     Veevee's own pool group at BytePlus **and then the pool group** (irreversible; owner approval), then
     migrates `assets` back to `0004` (reverses 0006 and 0005; drops only the five pool tables) and
     verifies both migration rows are gone (62 → 60).
  4. Roll the services back per `release-runbook.md`.
  Generations, media, ledger rows and all other tables are untouched.

## Local verification (2026-10-14)
- Backend suite in the production image; frontend suite, lint and build (see status.md).
- `local/smoke.py` through the frontend: images, Seedance draft→final MOV, ZIP, managed portrait
  (face upload → asset → video, Gallery, 410), real depth map on the local GPU worker.
- `local/ui_check.mjs`: Gallery and Admin card render, no console errors.
- Scenario tests (`apps/assets/test_managed_pool.py`): sharing, eviction, pinning, wait limit,
  quota, uncertain reconcile, janitor expiry, Gallery delete, draft→final re-register, remote
  drift, group recreation, failed-job re-verification, rollback command.

## Local verification of v2 (2026-10-16)
- Scenario tests: `apps/assets/test_portrait_gallery.py` (Gallery API, first come first served between
  two waiters and an upload, group adoption by name incl. a duplicate-create race, janitor recovery,
  missed-face learning at creation and asynchronously with a Retry through `asset://`, 410 on every old
  route, upgrade from 0005), `apps/assets/test_portraits_cutover.py` (dry run, exact-count apply,
  idempotence, pool group untouched), `deploy/test_portrait_gallery_routes.py` (gateway, migration counts).
- Fake providers (`backend/testsupport`): Seedance refuses inline images with configured SHA-256s as a
  real person (`reject_image_sha256`, `reject_mode` `create` | `async`; also `POST /control` on the local
  fake provider server); `DeleteAssetGroup`; `ListAssetGroups` name filter and pagination.
