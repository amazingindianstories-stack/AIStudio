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
   `rehearsal_worker.py` (fake provider network behind the paid guard's check; the API's own
   Gemini host, used by the admin agent, is faked by `scripts/release/rehearsal_api/`). The probe
   drives Nano Banana, Seedream, Seedance draft → final, Magnific, an audio transcription, admin
   user/limit changes and a ZIP export through the gateway. One agent worker (`manage.py agent_worker`, API role,
   fake Gemini host, throwaway `MCP_QUOTE_SECRET`) runs too: the probe turns Agents on for a rehearsal admin account
   (and restores it), advances one small run to `completed` with one `agent_llm_usage` row and its events read by
   cursor, and stops a second run. It checks the runtime-role grants on every table added by canvas 0018-0019 and
   agents 0003-0005, and when `canvas.0019_format_payloads` is pending it applies it alone first and prints the
   data step's duration.
   Verified to fail on the 2026-10-13 missing-import regression.
3. `stage_railway_deploy.py` refuses a commit without both pass records.
4. Proposed, not built (needs owner budget approval): a tiny real paid canary per provider right
   after a worker deploy with automatic rollback on failure.

## Maintenance write freeze (Vercel, including the old Railway backend)

Use this before the generation-name migration and credential rotation. Enforcement lives in
`src/middleware.js`, before the Django rewrite and ingress header, so it works while the old
Railway API still runs. Only POST `/api/auth/login`, `/api/auth/logout` and the read-only
signed-URL lookup `/api/media-resolve` bypass the write freeze. Sign-in and sign-out keep
working, including signing in again after session-key rotation. GET/HEAD reads, direct
thumbnail/media URLs and original downloads keep working. All other `/api` methods return
HTTP 503 with `code: "MAINTENANCE"`, a short message and `Cache-Control: no-store`. Creating a
new ZIP is a write and is paused; downloading an already-ready ZIP remains available.

The switch is the boolean `veevee_maintenance` in Vercel Edge Config (now called Global Config).
[Vercel supports it on all plans](https://vercel.com/docs/storage), so a runtime config update
avoids rebuilding or redeploying for each toggle. The maintained `@vercel/global-config` SDK
reads the server-only connection string from `GLOBAL_CONFIG` (newly connected stores) or
`EDGE_CONFIG` (older connections); `GLOBAL_CONFIG` wins if both are set. Do not expose either
as `NEXT_PUBLIC_*`.
There is one switch, with no second Railway flag to reconcile.

### One-time preparation, before the freeze window

These are owner-approved release actions, not actions performed by implementing this feature:

1. In the correct Vercel team, create or select a dedicated Edge Config/Global Config store.
   Add `veevee_maintenance` as JSON boolean `false`, not string `"false"`.
2. Connect it to the actual Veevee Vercel project for **Production** only. Confirm its read
   connection is provided as `GLOBAL_CONFIG` or `EDGE_CONFIG`, and that a set `GLOBAL_CONFIG`
   points at this store. Keep the value in Vercel's secret settings.
3. Deploy the frontend containing this middleware, with the connection, ahead of the window
   while the old Railway backend is still running. This initial rollout requires a deployment;
   subsequent ON/OFF updates do not. Verify the actual project, target, every Production domain
   and alias, browser/CSRF origins, login and browsing against that backend before scheduling
   the migration. Keep the freeze-capable frontend active throughout rollback; an older
   frontend deployment without this middleware cannot enforce the switch.
4. With the key false, check `GET /api/maintenance` on each Production origin returns
   `{"enabled":false,"available":true}` with `Cache-Control: no-store`. An unavailable source
   also reports OFF but `available:false`, which is **not** a successful setup verification.

### Turn ON and verify

1. Drain or stop the external GPU depth workers first. They reach Django only through this
   middleware, so their claim, heartbeat, progress, upload-url and complete calls are frozen
   too; a depth job still running when the switch goes ON cannot finish and is left to the
   server reaper.
2. In the connected store's Items editor change only `veevee_maintenance` to boolean `true`,
   then save. Record the UTC time and config version/digest with the release receipt.
3. Allow Vercel propagation plus the five-second per-isolate cache. Open tabs poll every five
   seconds and refresh on focus, so allow another five seconds for their controls. A config
   read has a two-second deadline. These intervals bound local cache/poll delay, not Vercel's
   global propagation; the probes below, not a timer, establish the freeze. Recheck from each
   Production origin and at least the regions/session locations used by the team.
4. Using the exact approved HTTPS origin, verify a fresh status and a harmless write-method
   probe (the following requests carry no credentials or customer data):

   ```sh
   curl --fail-with-body -sS -D - "$VEEVEE_ORIGIN/api/maintenance"
   curl -sS -D - -X OPTIONS "$VEEVEE_ORIGIN/api/folders"
   ```

   Require `enabled:true, available:true` on the first response; the second must return 503
   JSON with `code: "MAINTENANCE"`, `X-Veevee-Maintenance: 1`, and no-store. Verify no matching
   OPTIONS request reached Railway. Do not proceed on a failed or inconsistent probe.
5. In a signed-in browser, verify the non-dismissable banner says "Veevee is being updated.
   You can browse, but creating, uploading and organising are paused for a few minutes."
   Verify Generate, file uploads, new folder, folder actions, generation retry/finalize,
   favourite, move and delete controls are disabled, while composer-only actions such as
   Edit & retry and Clone & try stay enabled. Check an already-open tab too. Browse folders,
   open a generation and download its original; verify login/logout still work.
6. Drain already-admitted generation/export jobs, wait for requests accepted before the
   freeze to settle, and establish the quiet window using the queries above. This switch
   stops new browser/API writes and freezes the depth workers; the generation and export
   workers on Railway keep running and draining, and accepted jobs are not undone. Existing
   direct-to-GCS resumable sessions can finish an in-flight chunk, but blocked init/finalize
   requests cannot publish a new READY reference. Coordinate any independent writers before
   the backup/migration. Only then begin the separately approved migration and rotation.

### Turn OFF and verify

1. Complete migration/restore verification and the credential rotation first. Keep ON through
   any emergency restore. Confirm the compatible backend and workers are healthy, then save
   `veevee_maintenance: false` in the same store.
2. Allow propagation and cache/poll intervals as above. On every Production origin require
   `GET /api/maintenance` to return `enabled:false, available:true`. Only then restart any
   depth workers stopped before ON. Repeat the OPTIONS probe:
   it must now reach Django and no longer return the middleware's MAINTENANCE response (Django
   may reject OPTIONS under its own routing policy).
3. Verify the banner disappears in both a fresh browser and an already-open tab, Generate and
   organisation/upload controls recover, and login works after the one-time logout. Run any
   approved write smoke check from the release plan and record its result. Do not automatically
   replay writes rejected during maintenance.

### Source failure

A missing connection or key, a non-boolean value, an SDK error or a read timeout makes the
read unavailable. An isolate that has read the switch successfully keeps its last good value
(so a known ON stays ON) and logs `[maintenance] Toggle unavailable; keeping last known state
(ON).` or `(OFF).`; an isolate that has never read it **fails open (OFF)** and logs
`[maintenance] Toggle unavailable; failing open (OFF).`. Logs never include the exception or
connection string, and status reports `available:false` either way. Each result is cached for at
most five seconds, then re-read. A fresh isolate during an outage starts OFF, so ON is not
guaranteed everywhere while the source is down. A disconnected browser retains its last observed
UI state until a successful poll. Monitor status and the sanitized log during the
window. If the source becomes unavailable, do not start or continue a migration assuming this
switch is a write barrier; re-establish a verified quiet window before proceeding.

## Staging an upload
```
python3 scripts/release/stage_railway_deploy.py [--no-overlap] <commit> <component> <empty-dir>
# serviceInstanceUpdate(environmentId, serviceId, input: <the printed serviceInstance object>)
railway up <dir> --path-as-root -p <project> -e <environment> -s <service-id> -c
```
The staged directory holds only `backend/` from `git archive` and a generated `railway.json`
(Dockerfile `backend/Dockerfile`, start command, health/overlap). Any `railway.toml` an older
commit carries is dropped, so the generated file is the only service configuration file. Railway
builds and deploys with the service instance's settings, not the file's, so apply the printed
`serviceInstance` object (the same settings plus `dockerfilePath`) to the instance immediately
before `railway up`, on every service including a new one.
`<component>` is `api`, `mcp`, `generation`, `export`, `scheduler`, `agent` or `pgbouncer` (the connection pooler, a different
image: see the pooler rollout below). `api` and `mcp` get the readiness
health check and a 20 s overlap; `generation` and `agent` overlap 0; `agent` serves no HTTP, so it has no health
check, port or domain. `--no-overlap` (`api` and `mcp` only) stages `overlapSeconds` 0 for the no-overlap pause
below; without it nothing changes.

**Learned on the API cutover (2026-10-13):** Railway ignored the uploaded `railway.json` start
command (deployment meta had no file manifest), so the new image first ran the old launcher and
failed its health check harmlessly. The start command must be set on the service instance
(`serviceInstanceUpdate … startCommand`) immediately before `railway up`; running deployments keep
their own snapshot. **A new service** has no `dockerfilePath`, so Railway builds it with Railpack,
which fails in seconds ("Railpack could not determine how to build the app", deployment FAILED
with no deployment logs): green-django-mcp on 2026-11-02 and green-django-agent on 2026-11-06.
Confirm `meta.serviceManifest.build.builder` is `DOCKERFILE` in the new deployment. Railway
health checks target `$PORT` (injected as 8080), not the domain's target port, so the API needed
`PORT=18081` (old launcher ignores it). The previous API deployment never had a health check at all.
Always confirm the applied start command in the new deployment's `meta.serviceManifest`.

## Order (one service at a time; verify before the next)
1. **API** (health check `/__g4_readiness`, overlap 20 s, drain 30 s). A failed start or
   failed preflight never takes traffic; the old deployment keeps serving.
   Verify: deployment meta shows the new start command and image; readiness; `/api/health`
   through veevee.ai; login; history; a media redirect (`private, no-store`); portraits list;
   `/api/media-resolve` returns signed URLs; no new 5xx.
   **Release containing `canvas.0019_format_payloads`: no overlap.** No service on the old image
   may read or write boards once a service on the new image serves. A save by the new release takes a
   board's Docs, HTML and draw.io payloads out of its JSON, and a save of that board by the old
   release would then store them empty ([board-formats.md](../features/board-formats.md#payload-storage)).
   Two services write boards: the API and the MCP service (`green-django-mcp`, the same image run as
   `python -m deploy.entrypoint mcp`, whose board tools save through the same path). In one pause:
   remove the active API and MCP deployments and confirm both have stopped (no new requests in their
   logs, draining over); only then apply `canvas.0019_format_payloads` (never before the pause: an
   old-image edit saved after it lands next to a stale reference, and the new release serves the
   stale payload row and drops the edit on its next save); then `railway up` the API with
   `overlapSeconds` 0 on its instance and in the staged `railway.json` (`stage_railway_deploy.py --no-overlap`), and deploy MCP
   from the same commit the same way before it serves again. The API and agent tools are unavailable for that pause. Promote the frontend that reads payloads
   lazily only after the new API serves: against the old API it would save format objects without
   their payloads. Later releases use the overlap above.
2. **Generation worker** (overlap 0, drain 120 s): only with no queued/running jobs.
   Started provider work and its result download share a 30-minute hard deadline. A deploy or
   restart interrupts jobs still within their 30 minutes: SIGTERM cooperatively cancels local
   I/O (a synchronous paid call already on the wire is given up to 90 seconds to finish), and Railway's 120-second drain does not grant a 30-minute render window. Let the queue
   empty before restarting; synchronous providers may still finish and bill interrupted work.
   The stable `queue_execution_deadline` code now says our time limit was reached, rather than
   claiming a dropped provider connection. Receipt-less orphan recovery waits 31 minutes and
   excludes live leases; accepted provider task receipts remain recoverable without resubmission.
   Verify the startup log reaches the worker loop (preflight passed) and the next real job is claimed once.
3. **Export worker**, then **scheduler**: verify startup, then an export ZIP (filenames, MOV
   bytes) and the scheduler lease.
   **Agent worker** (new service, `agent`, overlap 0, no health check or domain; stage it with
   `stage_railway_deploy.py <commit> agent` and apply its `serviceInstance` settings): after the scheduler, so a stale run is re-queued. Verify the startup
   log reaches the worker loop and a run started by an admin account reaches `completed`.
4. Watch the rollback thresholds in `status.md` for a full reconciliation window.

Separate later single-variable steps: `DEPTH_WORKER_TOKEN` on the API (F-04),
`VEEVEE_PUBLIC_APP_URL_OVERRIDE=https://veevee.ai` (F-01).

## Database pooler rollout (audit deploy stage)

Puts the transaction-mode PgBouncer (`infra/pgbouncer`, why and how big: [database-connections.md](database-connections.md))
between every service and PostgreSQL. It is a stage of the audit deploy, after the steps above, and it changes nothing
in PostgreSQL's data or schema. The code already runs both ways: a service connects directly (today) unless its
variable `VEEVEE_DB_POOLER=green-pgbouncer.railway.internal:6432` is set, so **the variable is the switch and unsetting
it is the instant rollback**. The direct database URL is never removed.

Preconditions: the audit commit (which contains the pooler-safety fixes and `deploy.check_pooler`) is deployed and
verified on every service (order above), the release gate and local rehearsal passed for that commit, and the 9
spare PostgreSQL connections are free (the `db-connections` check in the admin status is `ok`).

**P1. Lookup role for the pooler (owner, once).** As the PostgreSQL owner, in the application database, run
`psql "$OWNER_URL" -v auth_password="'<new password>'" -f infra/pgbouncer/auth.sql` (the same password goes to the pooler
as `PGBOUNCER_AUTH_PASSWORD`). It creates `pgbouncer_auth` (login, no other privilege, `CONNECTION LIMIT 2`) and the
restricted `pgbouncer.get_auth` lookup, which only returns `goal4_*` login roles. Verify as `pgbouncer_auth` that
`SELECT usename FROM pgbouncer.get_auth('<api role>')` returns that one role and that the same call for a superuser
returns nothing. No application role, table or privilege changes.

**P2. Create the pooler service `green-pgbouncer`.** Private network only: no public domain, no TCP proxy. Variables:
`PGBOUNCER_UPSTREAM_HOST=green-postgres18.railway.internal`, `PGBOUNCER_AUTH_PASSWORD`, `PGBOUNCER_ADMIN_PASSWORD`,
`PGBOUNCER_DATABASE_CA_PEM` (the pinned CA the services already hold) and, to fail closed, `PGBOUNCER_DATABASE_CA_SHA256`
(`infra/pgbouncer/README.md`). Stage and deploy it exactly like any service, from the qualified commit:
```
python3 scripts/release/stage_railway_deploy.py <commit> pgbouncer <empty-dir>
# serviceInstanceUpdate(environmentId, serviceId, input: <the printed serviceInstance object>)   # sets the Dockerfile
railway up <empty-dir> --path-as-root -p <project> -e <environment> -s <green-pgbouncer-id> -c
```
Confirm in the new deployment's `meta.serviceManifest` that the builder is `DOCKERFILE` and `infra/pgbouncer/Dockerfile` built
(a new service otherwise falls to Railpack, as in the notes above). Startup log: `pgbouncer ... process up`, no
`pgbouncer: database CA does not match`, no auth errors. Nothing connects to it yet.

**P3. Verify on the staged environment before switching anything.** In each component's own running container (it
holds that component's variables) check its alias. The helper builds the URL with the real code path and prints
only settings, never the URL or a credential:
```
railway ssh -s <scheduler-service-id> -- python -m deploy.check_pooler scheduler green-pgbouncer.railway.internal:6432
```
Repeat in the `export`, `generation`, `agent`, `mcp` and `api` services (`<component>` is that service). Every line must say `ok` and the
last `OK`: the right role, `application_name` `veevee-<component>`, and that alias's two timeouts. Then read the
pooler's admin console the same way (the application image has no `psql`; the `pgbouncer_admin` password goes on stdin,
never on the command line):
```
read -rs PW; printf '%s\n' "$PW" | railway ssh -s <scheduler-service-id> -- python -m deploy.check_pooler admin green-pgbouncer.railway.internal:6432 "SHOW DATABASES"
```
`SHOW DATABASES` lists the seven aliases (`veevee_auth` included) with their `pool_size`, and `SHOW POOLS` (same form) shows
`sv_active` 0 after the checks. Stop here on any mismatch: no service has been touched.

**P4. Switch one service at a time, behind health checks.** For each service in this order, set
`VEEVEE_DB_POOLER=green-pgbouncer.railway.internal:6432` on that service and let it redeploy by the usual path, then
verify before the next. Order: scheduler, export, agent, mcp, generation, api.
- scheduler, export, agent: startup log reaches the worker loop; the scheduler lease keeps ticking; an export ZIP builds
  (agent: a run reaches `completed`).
- mcp: readiness, a tool call.
- generation: **only with no queued or running jobs** (overlap 0, drain 120 s as above). Verify the next real job is
  claimed once and its heartbeat renews (`SHOW CLIENTS` shows the worker's clients, `SHOW POOLS` `sv_active` returns to 0).
- api (health check `/__g4_readiness`, overlap 20 s): readiness, login, history, a media redirect, portraits, a
  resumable upload round trip (init, chunks, finalize, cancel), no new 5xx.
After each switch: `SHOW POOLS` has `cl_waiting` 0 for that alias, `maxwait` 0 at idle, and the admin `db-connections` check
shows its `veevee-<component>` count inside its budget. Wait one full reconciliation window before the next service.

**P5. Watch.** For a day: the `db-connections` check stays `ok` (the scheduler logs a warning on `veevee.maintenance` at
80% and the check turns to `error`), `SHOW POOLS` `cl_waiting` stays at 0 at idle and under load, no `query_wait_timeout`
errors in the API logs. Then record the date and commit in `status.md` and remove the old direct-connection tuning
notes from the record; keep the variable-unset path, it is the rollback.

**Rollback.** Per service: unset `VEEVEE_DB_POOLER` and redeploy (the service reconnects to the direct URL with the
identical settings it ran before). Roll back in the reverse order (api first), one at a time, and before the api goes
direct confirm there are 8 free connections (`db-connections` check; the api needs up to 8 direct). If the pooler itself
misbehaves while services are still on it, use its admin console (`check_pooler admin`, P3): `RECONNECT veevee_<alias>` (reopens its server
connections) or `KILL veevee_<alias>` (drops its clients), and unset the variable on the services as above. Removing the `green-pgbouncer` service is
never part of a rollback: it holds no data and costs nothing idle. Nothing here touches PostgreSQL, so there is nothing to
restore; never run a destructive migration or change `max_connections` as part of it.

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
- The scheduler runs the `cleanup_uploads` sweep daily at 03:17 UTC with limit 100: it removes
  expired incomplete private uploads and never touches READY references or shared originals.
