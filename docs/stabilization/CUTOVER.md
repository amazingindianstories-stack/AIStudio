# Green cutover to the versioned image (gate A1) — runbook

Replaces the env-injected launcher code with the image built from this branch. The image's
entrypoint (`python -m deploy.entrypoint <component>`) reads the services' **existing**
configuration variables (`deploy/legacy_config.py`), so the cutover changes only the image and
start command — **no variable is added, removed or edited**. No values belong in this file.

## Preconditions
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

## Staging an upload
```
python3 scripts/stabilization/stage_railway_deploy.py <commit> <component> <empty-dir>
railway up <dir> --path-as-root -p <project> -e <environment> -s <service-id> -c
```
The staged directory holds only `backend/` from `git archive` and a generated `railway.json`
(Dockerfile `backend/Dockerfile`, start command, health/overlap). The repository's
`railway.toml` files are never uploaded — the root one would start the generation worker.

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
4. Watch the rollback thresholds in `STATUS.md` for a full reconciliation window.

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
