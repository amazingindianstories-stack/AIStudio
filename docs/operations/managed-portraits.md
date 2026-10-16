# Automatic portraits (managed BytePlus pool) - rollout and rollback

Status 2026-10-14: implemented and verified **locally only** (local stack, release gate, rehearsal).
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
- The Portrait Gallery becomes a read-only view (status, in-use, expiry, Add to prompt, Remove).
  Manual portrait upload/registration returns 410 `PORTRAITS_ARE_AUTOMATIC`.
- Admin → Limits → Portrait storage: TTL hours (1–72), pool size, longest wait.

## Pieces
| Piece | Where |
|---|---|
| Migration (5 new tables, grants to existing roles) | `apps/assets/migrations/0005_managed_portraits.py` |
| Pool, janitor, reconcile | `apps/assets/managed_pool.py` |
| Worker preparation before admission | `apps/generation/services/portrait_prepare.py`, `executor._prepare_portraits` |
| Scheduler janitor (60 s) | `apps/workers/scheduler.py` (only when the flag is on) |
| Routes | `GET /api/portraits/managed`, `DELETE /api/portraits/managed/<id>`, `GET/POST /api/admin/portrait-settings` (gateway allowlisted; Django enforces admin) |
| Flag | `VEEVEE_MANAGED_PORTRAITS=1` (default off). The launcher passes it to API, generation and scheduler only |
| Worker credentials | generation + scheduler need `GOAL4_PREVIEW_PORTRAIT_CONFIGURATION` (same value as the API's); with the flag on and no credentials they refuse to start |
| Rollback | `python manage.py managed_portraits_rollback` |

## Preconditions (all required)
1. Release gate **and** rehearsal pass records for the exact commit
   (`scripts/release/release_gate.sh`, `rehearse_local.sh` - the rehearsal applies the
   migration as the owner and runs the pool with the real database roles).
2. The generation worker is on the versioned image (it is still on the old launcher after the
   2026-10-13 incident) - that redeploy is its own approval and goes first, flag off.
3. Owner decision on the existing remote assets (59 Active + 51 archived): the pool needs free
   BytePlus slots (`QuotaSharedPoolExceeded` since 2026-10-13 18:21 IST). The approved plan is to
   clean them at rollout together with the old internal portrait state.
4. An idle moment (no queued/running jobs).

## Rollout order
1. Deploy the new image to every service with the flag **off** (behaviour identical to today).
2. **Migration** (owner DSN, one-off): `python manage.py migrate --noinput` → `django_migrations`
   goes 60 → 61. From here the **old launchers cannot start** (they assert 60 rows; the new
   preflight accepts 60 or 61). Rolling a service back to an old launcher now requires the rollback
   below first.
3. Add `GOAL4_PREVIEW_PORTRAIT_CONFIGURATION` to the generation worker and scheduler (reference
   the API's variable; never printed).
4. Remote cleanup of the old assets (approved list only), then set `VEEVEE_MANAGED_PORTRAITS=1` on
   API, generation worker and scheduler; redeploy API → generation (idle) → scheduler.
5. Verify: startup logs pass preflight; `GET /api/portraits/managed` → `enabled: true`; one owner-
   approved Seedance face job (paid canary) → asset ACTIVE, `asset://` in the receipt, MOV master;
   janitor runs (scheduler log); Gallery and Admin card render.

## Rollback
- **Flag only** (fast, keeps the schema): set `VEEVEE_MANAGED_PORTRAITS=0` (or remove it) on the
  three services and redeploy. Face references go inline again as before.
- **To an old launcher** (needs the 60-row history):
  1. Flag off on every service (above); wait until no generation holds a pin.
  2. Report: `python manage.py managed_portraits_rollback` (owner DSN, flag off in that process).
  3. `python manage.py managed_portraits_rollback --delete-remote --confirm` - deletes every asset in
     Veevee's own pool group at BytePlus (irreversible; owner approval), then migrates `assets` back
     to `0004` (drops only the five pool tables) and verifies the migration row is gone.
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
