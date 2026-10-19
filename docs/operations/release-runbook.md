# Release runbook (Railway Green backend)

How a backend commit reaches the Railway Green services. Every production step needs explicit
owner approval; current deployment state is in `status.md`. No values belong in this file.

The image's entrypoint (`python -m deploy.entrypoint <component>`) reads the services' **existing**
configuration variables (`deploy/legacy_config.py`), so a release changes only the image and
start command - **no variable is added, removed or edited** unless the owner approves that change.
The first use of this procedure was the 2026-10-13 cutover from the env-injected launcher (gate A1);
the preconditions below are its record.

## Preconditions (2026-10-13 cutover)
- P0 backups present and restore-verified; rollback set recorded per service (deployment id,
  image digest, start command, variable-value hashes) in the private baseline.
- Branch green: backend suite (649/650, the Node interop test needs Node), frontend suite, lint,
  build; `makemigrations --check` and `migrate --plan` → no changes / no operations against the
  restored production copy.
- Local rehearsal of the exact image on an internal (no-internet) network against the restored
  copy with the production roles: all four services start; readiness, ingress refusal, session,
  history, counts, paged updates, portraits, media-resolve, idempotent enqueue and the
  removed-portrait refusal pass.
- Quiet window, checked immediately before each service (read-only):
  `SELECT status, count(*) FROM generations WHERE status IN ('queued','running') GROUP BY 1;`
  `SELECT status, count(*) FROM media_exports WHERE status IN ('queued','running') GROUP BY 1;`

## Release gates (required for every deploy, 2026-10-13)
1. `scripts/release/release_gate.sh <commit>` - clean detached worktree; image build; pyflakes
   undefined names; full Django suite **inside the built image** on a throwaway PostgreSQL 18,
   including fake-provider worker simulations (`apps/generation/test_worker_simulation.py`);
   `makemigrations --check`; frontend tests, lint, production build.
2. `scripts/release/rehearse_local.sh <commit>` - the commit's image on an internal
   (no-internet) Docker network against a restored Green copy with production roles/RLS: API with
   the real entrypoint (paid guard, export admission, portrait lifecycle, gateway), workers via
   `rehearsal_worker.py` (fake provider network installed before the paid guard; the API's own
   Gemini host, used by the admin agent, is faked by `scripts/release/rehearsal_api/`). The probe
   drives Nano Banana, Seedream, Seedance draft → final, Magnific, an audio transcription, an admin
   agent message, admin user/limit changes and a ZIP export through the gateway.
   Verified to fail on the 2026-10-13 missing-import regression.
3. `stage_railway_deploy.py` refuses a commit without both pass records.
4. Proposed, not built (needs owner budget approval): a tiny real paid canary per provider right
   after a worker deploy with automatic rollback on failure.

## Staging an upload
```
python3 scripts/release/stage_railway_deploy.py <commit> <component> <empty-dir>
railway up <dir> --path-as-root -p <project> -e <environment> -s <service-id> -c
```
The staged directory holds only `backend/` from `git archive` and a generated `railway.json`
(Dockerfile `backend/Dockerfile`, start command, health/overlap). Any `railway.toml` an older
commit carries is dropped, so the generated file is the only service configuration.

**Learned on the API cutover (2026-10-13):** Railway ignored the uploaded `railway.json` start
command (deployment meta had no file manifest), so the new image first ran the old launcher and
failed its health check harmlessly. The start command must be set on the service instance
(`serviceInstanceUpdate … startCommand`) immediately before `railway up`; running deployments keep
their own snapshot. Railway health checks target `$PORT` (injected as 8080), not the domain's
target port, so the API needed `PORT=18081` (old launcher ignores it). The previous API
deployment never had a health check at all. Always confirm the applied start command in the new
deployment's `meta.serviceManifest`.

## Order (one service at a time; verify before the next)
1. **API** (health check `/__g4_readiness`, overlap 20 s, drain 30 s). A failed start or
   failed preflight never takes traffic; the old deployment keeps serving.
   Verify: deployment meta shows the new start command and image; readiness; `/api/health`
   through veevee.ai; login; history; a media redirect (`private, no-store`); portraits list;
   `/api/media-resolve` returns signed URLs; no new 5xx.
2. **Generation worker** (overlap 0, drain 120 s): only with no queued/running jobs. Verify the
   startup log reaches the worker loop (preflight passed) and the next real job is claimed once.
3. **Export worker**, then **scheduler**: verify startup, then an export ZIP (filenames, MOV
   bytes) and the scheduler lease.
4. Watch the rollback thresholds in `status.md` for a full reconciliation window.

Separate later single-variable steps: `DEPTH_WORKER_TOKEN` on the API (F-04),
`VEEVEE_PUBLIC_APP_URL_OVERRIDE=https://veevee.ai` (F-01).

## Rollback (per service)
Primary: dashboard **Rollback** to the recorded previous deployment id, which restores its image.
Then confirm the active deployment's start command is the old launcher command; variables were not
changed, so nothing else needs restoring.
Fallback (if the rollback kept the new start command): stage the extracted previous image source
(private baseline `image-source/full` as `backend/`) with `backend/Dockerfile` and a `railway.json`
whose start command is the recorded launcher command, and `railway up` it.
Never re-run provider requests; uncertain jobs stay uncertain.

## Rollback principles
- Roll an image back only to a previously qualified, compatible release. Keep additive schema and
  accepted provider task receipts; never run destructive down-migrations or delete production
  records, and never roll the export worker back to a version that cannot read queued manifests.
- For data corruption, restore point-in-time recovery into an isolated database, verify the
  invariants there, then switch targets with approval. Never use the original database as a
  diagnostic scratch area.

## Environment separation
- `.env.local.example` lists only frontend transport and public UI settings; `backend/.env.example`
  lists backend configuration names without values. Django never loads dotenv files.
- Provider, storage, session and database secrets live in the Railway service variables only.
  Keep them off Vercel and out of logs, source archives, image build contexts and this repository.
- Browser origins and allowed hosts are explicit HTTPS values; never widen them with wildcards to
  work around proxy or cookie problems.
- Schedule `cleanup_uploads` only after operator review: it removes expired incomplete private
  uploads and never touches READY references or shared originals.
