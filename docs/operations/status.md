# Veevee stabilization - status

Spec: `Veevee_stabilization_revised_agent_plan.md` (P0–P6). Branch `stabilization/2026-10-13`
(worktree `../veevee-stabilization`, from `d9ef939`). The pre-existing uncommitted tree is preserved
unchanged in the owner's checkout and snapshotted as local branch `wip/django-consolidation-2026-10-13`
(`2791f02`). Private artifacts (backups, launcher bytes, env value hashes) live in the owner's private
root `…/goal4-private/stabilization-2026-10-13/` (0700/0600, FileVault on) - never in Git.

**The GitHub repository is public.** Nothing in this file or any commit may contain secrets,
connection strings or private hostnames. Local commits are not pushed without owner approval.

**Testing rule (owner, 2026-10-13):** every stability check and every change is tested locally or on a
preview build first. Production only receives a release after it has passed there and the owner approves.

Legend: PASS · FAIL · NOT VERIFIED · PENDING (not started) · BLOCKED (needs owner approval)

## Phase summary
| Phase | State | Notes |
|---|---|---|
| P0 Baselines / rollback | PASS (rollback execution NOT VERIFIED) | see below |
| P1 Git baseline | PASS | migrations restored from image; backend byte-identical; suites green |
| P2 Correctness fixes | P2.1, P2.2, P2.4, P2.5 PASS; P2.3 PARTIAL | idempotent enqueue + submit-time portrait check added |
| P3 Versioned image + cutover | P3.1–P3.2 PASS; P3.3 PASS (local, worker hand-off NOT VERIFIED); cutover PENDING (owner OK'd, needs manual-mode session) | see P3 |
| P4 Media off Vercel | Code PASS (local); release with A1/A3 | resolver + direct URLs; frame extraction still via /api/media (no CORS needed yet) |
| P5 UI perf + copy | Code PASS (local); release = A3 | notices, dialogs, error copy, portrait labels, confirmations |
| P6 Retire Blue | PENDING (gate A5) | |
| Credentials | BLOCKED (gate A4) | Higgsfield token exposed |

## P0 - Baselines and rollback (2026-10-13)
| Gate | State | Evidence |
|---|---|---|
| P0.1 Live baseline captured | PASS | Launcher bytes for api/generation/export/scheduler with SHA-256 (api inner `963f2e3b…`, generation `7c533dc5…`, export `5434d153…`, scheduler `c69fd589…`); deployment IDs api `488d4b18`, generation `1bdedd40`, export `1979e20d`, scheduler `0cd7ab06`; image digests (api `sha256:08fc8065…`, generation `sha256:87388045…`, export `sha256:15eadb0f…`, scheduler `sha256:fa5d4e90…`); start commands; limits; env names + value hashes; Vercel production `dpl_5wVSa2cH…` (`782d0bd`). |
| P0.1 Dependency trace | PASS | Green variables reference no Blue host and not `image-video-project.vercel.app`. **Finding F-01:** generation/scheduler `app_origin` and API `GOAL4_PREVIEW_APP_ORIGIN` point to an old `aistudio-v1-*.vercel.app` preview deployment, not `https://veevee.ai` (fix in P3). **Finding F-02:** API launcher env sets `LOCAL_DATA_MODE=fixtures`, `MOCK_GENERATION=1`, `MOCK_ASSET_PROVIDER=1` for the API process (worker runs real providers) - make explicit in P3 settings. |
| P0.2 Green backup | PASS | `pg_dump` 18.6 custom format, 12,972,198 B, sha256 `c7985b5d…`, transfer hash match; globals without passwords. |
| P0.2 Restore + compare | PASS | Restored into isolated local PG 18.4 (socket only). Identical to production: `django_migrations` 60 rows incl. UTC applied timestamps (md5 `e58cd488…`), columns 266, indexes 94, constraints 246, functions 25. Minor-version gap 18.4 vs 18.6 noted. |
| P0.2 Media baseline | PASS | 3 Seedance 2.5 originals `video/quicktime` `.mov` (20.6/13.2/14.9 MB), 2 Seedream PNGs, 1 reference upload - SHA-256 recorded privately. |
| P0.3 Blue backup + restore | PASS | Blue production `pg_dump` 18.6, 11,152,527 B, sha256 `8946cf0c…`, restored: 31 tables, 6,650 generations, 18 users. Last Blue write 2026-10-12 11:14 UTC. |
| P0.4 Rollback set | NOT VERIFIED (documented, not executed) | Per service: deployment ID + image digest + start command + exact variable values (private, hash-pinned). Mechanism: restore variables from private snapshot with `railway variable set --skip-deploys`, then `deploymentRollback`/redeploy of the recorded deployment. Executing it would change production. |
| P0.5 Metrics baseline | PASS | Railway 24 h: API mem peak 1.17 GB / avg 0.44, CPU avg 0.015; HTTP 200 38,736 · 307 27,537 · 404 155 · 401 80 · **502 29** (pre memory raise); generation mem peak 0.98 GB; export 0.07; scheduler 0.15; postgres 0.35. Estimated usage: **Blue ≈5.5× Green memory and ≈6× disk**. Vercel 7 d: effective ≈$0.05–0.10/day (function invocations + origin transfer), billed ≈$0. |
| P0.6 Credential quarantine | PASS (rotation BLOCKED) | Access-key CSV moved from `docs/` to private quarantine. Public-history scan (360 pushed commits): `.higgsfield-mcp-token.json` committed in 3 commits (`e698cbd`, `aa504cc`, `5dfec61`) and also included in the 2026-10-13 review zip → **rotate (gate A4)**. One DSN in `.env.local.example` history is a placeholder. No Google/AWS/OpenAI/private-key patterns found in pushed history. |

### Rollback thresholds (apply to every live step)
Abort and roll back if any of: API 5xx > 1% over 10 min or any 502 burst > 5/5 min; any OOM kill;
memory > 85% of limit for 10 min; generation lease/queue item older than 30 min without progress;
login failures > 3× baseline; media 403/404 > 2× baseline; any duplicate provider submission.

## P1 - Git baseline
| Gate | State | Evidence |
|---|---|---|
| P1.1 Applied migration graph in Git | PASS | **Finding F-03:** production's applied app migrations are the 26 `*_railway_v2_*` / `0001_uploadsession` / `0002_generation_submission_input` / `0004_uploader_provenance` files that existed **only inside the deployed image** - neither HEAD's 49 files nor the WIP tree's 26 recreated `*_baseline_*` files. 16 further `django_migrations` rows are legacy history with no files (ignored by Django, preserved untouched). Branch rebased onto the WIP snapshot (which matches the image's application code) and the image's migration files restored verbatim. Backend now byte-identical to the deployed image for all 291 image files. Against the restored Green clone: `migrate --plan` → "No planned migration operations"; `makemigrations --check --dry-run` → "No changes detected"; 26 applied / 0 unapplied. |
| P1.2 Bring forward intended edits | PASS | Branch is rebased on the WIP snapshot, whose application code is byte-identical to the deployed image (291/291 files after migration restore). |
| P1.3 Deployed frontend imported | PASS | `1950972`: exact Vercel `782d0bd` source (179 files, all byte-identical). Test-contract fixes `c12c31f`: middleware tests set the server-only ingress value and assert caller headers are replaced + fail-closed; unresolvable `asset://` → no display URL; API inventory fixture added. `npm test` 440/440, `eslint src --max-warnings=0` clean, `next build` OK. |
| Backend suite | PASS | Local venv + isolated PG 18.4: 586/590 (4 need libvips/pyvips, absent locally). Production-equivalent image built from `backend/Dockerfile` (Python 3.12, ffmpeg, libvips) + disposable `postgres:18.6`: 588/590; the 2 errors need repo `scripts/` and Node, absent from the image, and pass locally. Every test passes in at least one faithful environment. |
| P1.4 Overlay inventory | PASS (inventory) / contract tests PENDING | 21 embedded code blobs decoded privately and mapped (API: gateway, export admission, portrait pull/presence, private redirect, remote delete, upload registration, tombstones, ready thumbnails, stale-portrait guard, Seedance error copy, gallery registration guard, paid guard; workers: storage adapters, Seedream transport, worker portrait lookup, naming/lease namespacing, read-only pricing, export admission). |
| P1.5 Node remnants | PASS (already removed on WIP base) | Live frontend imports none; routing tests confirm no Node fallback. |

**Finding F-04 (production bug, depth maps):** the Green ingress gateway rejects every depth-worker
route (`POST /api/worker/depth/{claim,heartbeat,progress,upload-url,complete}`) and artist depth
enqueue/status (`/api/generate/depth`, `/api/generate/depth/status`) with
`PREVIEW_OPERATION_DISABLED`/`PREVIEW_PAID_PROVIDER_DISABLED` (403), and the API process has no
`DEPTH_WORKER_TOKEN`. Depth has been unusable since the Green cutover. Hotfix prepared privately
(gateway allowlist + token pass-through, launcher inner sha `287ca2fc…`); allowlist unit-checked.
Depth enqueue writes rows directly (`apps/workers/views.py`) and never reaches paid providers.
Deployment needs owner approval (gate **A0-depth**).

## P2 - Correctness fixes
| Gate | State | Evidence |
|---|---|---|
| P2.1 Non-skipping updates | PASS | `d768416`. `backend/apps/generation/updates.py`: oldest-first `(updated_at,id)` cursor, `next`/`more`, 30 s commit lag, active rows always included; `src/lib/live-cursor.js` drains pages, backs off on errors, ignores rows stuck >30 min for cadence. Tests: 250 changes in one interval, 150 identical timestamps, late commit, active rows (DB-backed); frontend unit tests. |
| P2.2 Media/finalize permissions | PASS | `189826a`. READY uploads readable/referencable by any signed-in user (live parity); unready/cancelled/export hidden; upload mutations, portrait registration and ZIP exports owner-only (live parity - those call sites imported the original function). Finalize-for-all. Allow/deny suite `apps/media/test_shared_access_policy.py`. |
| P2.3 Paid-job safety | PARTIAL | Audit (read-only): **fixed** Gemini re-submits after billed 200/ambiguous 5xx (`ab720df`, `providers/gemini.py`); **fixed** duplicate in-flight finals - finalize serializes on the draft row and reuses a queued/running final, re-finalizing after completion stays allowed per owner (`ab720df`, `enqueue_views.py`); **fixed** ambiguous failures now carry an `uncertainSubmission` marker + artist-facing warning (`82ff6be`). **Fixed (`a1da3c2`):** optional `Idempotency-Key` on enqueue - a re-sent POST returns the first generation (receipt under advisory lock in the insert transaction; concurrent test: 4 POSTs → 1 row). **Open:** orphaned task id after lease loss is not ledgered; Higgsfield preset re-call; duplicate callbacks may re-run best-of judge calls. **Overlay-only protections that must be ported before any overlay removal (P3):** one-shot RESERVED→ATTEMPTING and ATTEMPTING→SUBMITTING DB transitions per POST (stops retry loops and extra best-of POSTs), DB-enforced no-resubmit, endpoint allowlist per active execution, payload limits (candidateCount 1, Seedance MOV, duration ≤15), new-jobs-only reservation, worker RLS. |
| P2.4 Bounded thumbnails | PASS | `189826a`, `apps/media/derivatives.py` (ported live overlay: 32 MB/20 MP caps, one decoder per process, create-only, fallback to original) + `private, no-store` redirects. |
| P2.5 Canvas durability | PASS | `aaa33ad`. Pending draft per board until server ack; keepalive only < 60 KiB; recovery on reopen. Tests for failed save→unmount→reopen and keepalive sizing. |
| Live risk noted | - | Production now allows finalize-for-all (owner request) **without** the in-flight dedupe; until the P3 release, a double finalize from two tabs could submit two paid finals. The confirmation dialog mitigates single-tab double clicks. |

## P3 - Versioned image
| Gate | State | Evidence |
|---|---|---|
| P3.1 Overlays ported | PASS | Folded into source: shared READY reads, finalize, bounded thumbnails, no-store redirects (`189826a`); prefixed GCS namespace (`50be4c5`); Seedance policy copy, Seedream 240 s transport + diagnostics, Gallery registration guard (`0dd731c`); worker portrait/asset projections, stale-portrait GetAsset pre-queue guard (`e24ccd9`). Reviewed runtime app `apps/production_runtime`: paid guard (`b9aef60`), export admission (`5a806b5`), lease/naming namespaces + read-only pricing (`bcb5c1e`), portrait lifecycle - list-only sync, tombstones, create-once registration, remote-first delete (`b2e0c29`). All Railway/DB identity and source-hash pins removed; infra identifiers come from settings. |
| P3.2 Image + entrypoint | PASS (local) | `2fb7d4b`: `deploy/entrypoint.py` + ported ingress gateway (now with depth routes); `backend/Dockerfile` CMD → entrypoint. Matches production process model (gunicorn 1×8, timeout 25, graceful 5). Local smoke on PostgreSQL 18.6: readiness 200, no ingress header 403, health 200, blocked route 403, depth status reaches Django, all three workers start; fresh `migrate` applies the 26 migrations. Logs now go to stdout (production currently writes them to a private file). |
| P3.3 Staging | PARTIAL | Green backup restored into disposable PostgreSQL 18.6 with production roles, RLS and ledger functions. Verified ledger contract as the real roles: worker cannot see unregistered rows or call `reserve`; API `reserve` registers once, replay rejected; worker sees registered row; RESERVED→ATTEMPTING→SUBMITTING once, second claim refused. **NOT VERIFIED:** a full staged enqueue→worker run through the new image - blocked by the session permission classifier as a potential paid transaction even though no provider keys exist; needs owner permission to run. Portrait registration/delete behaviour tests with a fake BytePlus client are still missing (logic unchanged from production). |
| P3.4 Cutover | **API, export worker, scheduler** on the versioned image (generation worker rolled back to the old launcher after the 18:34 regression, see incident) (API 11:51 UTC; export 12:06; scheduler 12:11; generation worker 12:59 at an idle moment). API later redeployed with `DEPTH_WORKER_TOKEN` (F-04 fixed) and `549df6e` (rejected-portrait delete) | Three harmless failed attempts first (start command ignored from railway.json; health check on $PORT). Added service variable `PORT=18081`, start command set on the instance. Public health/me/history verified through veevee.ai; live logs: 200/401/307 only, no errors. Rollback: redeploy `488d4b18` + restore launcher start command. |

Known deliberate differences to verify at cutover: `config/wsgi.py` adds the repo's slow-request
and terminated-body wrappers (production called `get_wsgi_application()` directly); API logs go
to stdout; API gets `PUBLIC_APP_URL=https://veevee.ai` (F-01) and `DEPTH_WORKER_TOKEN` (F-04).
**F-05 (to investigate):** depth rows are created without `reserve()`, so under the worker-role
RLS the scheduler may not see them for depth reconciliation.
**F-06:** the gateway forces `Cache-Control: no-store` on every response (kept for parity).

## Incident 2026-10-13 10:27–10:33 UTC - failed Seedance jobs
Investigated read-only. Jobs `f0d8c76f`, `423ac2b7` (and `e0f57d0b` with the same references) carried
reference 12, Gallery portrait "R01_SC008_0008 (1)", soft-deleted (PreviewDeleted) at 07:42 UTC. The
worker guard refused it before any provider call (no charge; admin spend counts only succeeded rows).
Gaps: no submit-time check for plain portrait URLs, message did not name the portrait, composer could
not show it. **Fixed (`f925a7e`):** enqueue refuses removed/unready portraits with 400
`PORTRAIT_UNAVAILABLE` + reference index; worker message names the portrait; composer marks the card
"Unavailable" and blocks resubmit until removed. Verified in the local image rehearsal.

## Data reconciliation Blue → Green (2026-10-13, owner request)
Compared the Blue production dump (Blue unchanged since 2026-10-12 11:14 UTC) with Green.
- **Restored:** 21 generations created on Blue between 2026-10-10 18:46 and 2026-10-12 16:43 IST
  (20 images, 1 Seedance MOV) that never reached Green. Their media were already in the Green
  bucket under canonical keys (70/70 objects, 360 MB; Green reads canonical first). Imported in
  one transaction after a full pre-restore backup (private `backups/`), refusing on any existing
  id or missing user/project/folder. Naming clashes (20 of 21 Blue serials were already used in
  Green) resolved by appending after Green's highest serial per namespace; counters bumped; Green's
  existing names unchanged. Verified: 21 present + named, counters = max+1, rerun refused.
- **Not restored (owner decision / deliberate deletions):** 12 portraits + 12 portrait groups (owner:
  do not restore; Green copies of the same BytePlus assets were bulk-deleted by a user on
  2026-10-12 19:17 IST); 12 material assets (present in Green, edited, then deleted by their creator
  on 2026-10-12 18:59 IST and partly re-created).
- **Left as is:** shared rows where Green is newer (portrait statuses, folder colours, one canvas);
  one folder move made on Blue (folder `cd6a30f1`) not applied; 189 Blue-only activity-log rows.

## Incident 2026-10-13 18:34–18:55 IST - new generation worker failed Seedance jobs
`video_execution.read_assets` used `provider_asset_projection` without importing it (ported in
`e24ccd9`); every native Seedance job inside a project with material assets failed with NameError
before provider submission (10 jobs; ledger ATTEMPTING; nothing charged). Generation worker rolled
back to deployment `12917ca5` (old launcher + old image) at 18:55; fix `9317b27` + tests; release
gates built so the class of bug is caught locally (both gates verified to fail on it). **Generation
worker remains on the old launcher; redeploy only with both gates passed and owner approval.**
Owner: no production or Railway deploys for the rest of 2026-10-13.

## Portraits - BytePlus quota (2026-10-13)
Registrations fail since 18:21 IST with `QuotaSharedPoolExceeded`. Remote assets still held: 59 Active
+ 51 locally archived (PreviewDeleted without remote delete). Freeing the 51 needs remote DeleteAsset
calls - irreversible on BytePlus - **owner decision pending**. Fixed: definitively rejected
registrations can now be deleted (`549df6e`).

## Automatic portraits + full local stack (2026-10-14, local only)
Owner: no deploys on 2026-10-14; make Veevee fully functional locally first. Done locally: the
managed BytePlus portrait pool (see `managed-portraits.md` for rollout/rollback), the full local
stack (`local/README.md`: every service, fake providers, frontend, real depth worker on the Mac
GPU) and an end-to-end smoke that passes for images, Seedance draft→final MOV, ZIP export,
automatic portraits and depth. Findings fixed on the way: portrait settings blocked by the gateway;
launcher did not pass the portrait flag or give the generation worker/scheduler BytePlus asset
credentials; depth worker could not upload on local storage. Observed, unchanged (pre-existing,
also in production rows): a Seedance submission refused with 400 keeps its estimated
`cost_cents` on the failed row.

## Portraits v2 - Portrait Gallery, first come first served, missed-face recovery (2026-10-16, local only)
Branch `feat/portraits-v2`, not deployed, flag still off everywhere. Backend: migration
`assets.0006_portrait_gallery` (additive; `MIGRATION_ROWS` = 60, 61, 62), one hidden pool group adopted by
name, strict first-come-first-served slots, janitor recovery (stuck DELETING/PROCESSING, queued uploads,
hidden assets), shared Gallery API (`/api/portraits`), old portrait routes 410 in managed mode, Seedance
face rejections teach the face scan so Retry sends `asset://`, `portraits_cutover` command for the old
BytePlus assets. Rollout order, owner approvals and rollback: `managed-portraits.md`. Not done pending
owner confirmation: raising `admission.MAX_CONCURRENT['video']` to 8.

## Release 2026-10-15 - Magnific image + video upscale (owner approved)
Root cause of "upscale not working": since the Green cutover the gateway refused
`POST /api/generate/upscale` (F-07), and behind it the paid guard, the old-launcher worker, the
missing `MAGNIFIC_API_KEY` and the media-host allowlist also blocked it. Fixed on
`hotfix/magnific-upscale` (cut from the API's deployed `549df6e`, merged here), together with
the four Magnific video upscalers (Creative, Turbo, Precision, Topaz) and every documented parameter.

| Service | Deployment | Commit | Previous (rollback target) |
|---|---|---|---|
| API | `bb17da6d` | `a3b5d12` | `9b746f72` (`549df6e`) |
| scheduler | `86fc3d69` | `b611237` | `c1cc996f` (`086e8aa`) |
| generation | `c3ad599f` (versioned image, A1 for this worker) | `a3b5d12` | `12917ca5` (old launcher: restore its start command and `Dockerfile.worker` first; that file left the tree, recover it with `git show 1fed00c:Dockerfile.worker`) |
| Vercel | `dpl_qgFuZGXbXE8LKPAqJYjX8Ktj7PNC` | live files + upscaler UI (200 files, sha1-matched) | `dpl_9vNHNfyd2XiMKcefETJudHfbtetY` |

- Flag `VEEVEE_MAGNIFIC_UPSCALE=1` on API + generation; `MAGNIFIC_API_KEY` on generation only (the
  only reader). Feature rollback: set the flag to 0 and redeploy the API.
- Live checks: image Precision V2 + Creative and video Creative 720p succeeded on veevee.ai.
- Found live and fixed (`4c5f0b0`): image results come from `ai-statics.magnific.com`, video results
  from `cdn-magnific.freepik.com`; only the latter was allowlisted, so the first image job polled
  until the worker was redeployed, then completed.
- Hardened (`a3b5d12`) for large media on the 2 GB, two-slot generation worker: image results stop at
  80 MB while streaming and are validated by a sequential libvips decode (was: read up to 512 MB,
  then a full Pillow decode of up to 160 MP); an oversized, unreadable or undownloadable result fails
  after three attempts instead of polling forever; video masters stream to disk with a 4 GB cap and
  a 600 s budget.
- Both gates passed for every deployed commit; gate 1 also passes on this merge.

## F-07 - gateway blocks features in production (kept for parity)
The live ingress gateway refuses `POST /api/generate/upscale`, `/api/audio/transcribe`, admin writes
(`/api/admin/*` POST/PATCH/DELETE: user create/edit/delete, limits, pricing), agent message POSTs and
`/api/queue/execute`. Unchanged by the cutover; enabling them is a separate owner decision.
Upscale is open since 2026-10-15 behind `VEEVEE_MAGNIFIC_UPSCALE` (see the release above).

## P5 - UI performance (progress)
- `5cae45a`: one mounted assets panel (desktop only when open; drawer on mobile); ZIP status poll backs off, pauses when hidden, stops after 2 h; depth status 12 s only in Depth mode, else 60 s.
- `de7c76c`: draft videos marked with a dashed amber border + "Draft" label (owner request).
- `766cafd` watchdog/lazy chat video; `73fbd99`/`0bab3e9` cross-scope cache + page-1 merge; `4122c1e` bounded uploads.
- `9bb5d23` alert() → in-app notices; `2228407` prompt()/confirm() → in-app dialogs; `e02aee1` concise copy,
  neutral portrait labels, quieter reference strip; central API error copy (codes never shown raw).
- Frontend suite 469/469, lint clean, `next build` OK.
- Frontend suite 452/452, lint clean, build OK.

## Owner approval gates
- **A0-depth** Depth hotfix: gateway allowlist for depth routes + `DEPTH_WORKER_TOKEN` (value from the existing depth-worker config, never printed) on the Green API, then API redeploy.
- **A1** Green cutover to versioned image (P3), one service at a time.
- **A2** Bucket CORS + direct-media release (P4).
- **A3** Frontend release(s) (P5).
- **A4** Credential rotation: Higgsfield token (public history + zip), BytePlus ARK key and Google API key (exposed in a session log), deactivate the quarantined access key, verify the DB passwords in `docs/goal4/tools/qualify-green-private-auth-*.py` (untracked, owner's main checkout only).
- **A5** Blue shutdown (`railway down`, no deletion), pause Vercel `image-video-project`, remove unused Vercel secrets.

## Next safe action
2026-10-17 ~09:50 UTC: **hotfix `981f993` released** (API `e48952f3`, generation `c1a4f34b`, scheduler
`a1a04621`, export `1c4c5afe`, Vercel `dpl_CJvLGB5Woi3nSpaTeTaM3DdWciSs`; one video was running and finished
normally). BytePlus answered CreateAsset with 400 `QuotaWriteQPMExceeded` during an 11-portrait burst; it was
taken as a refusal and 4 face images were marked "send inline" (marks removed in production at 09:30). Write
limits now pause registrations for 60 s without judging the image. Admission caps running tasks per BytePlus
Seedance model (Admin -> Limits -> Seedance tasks per model, default 3 for the Individual account; BytePlus
queues anything above its own limit out of sight), 8 videos overall, 8 per user. Rollback targets: API
`29e6134f`, generation `8ba0b263`, scheduler `e001f0e4`, export `f7bdca38`, Vercel `dpl_CZA4uTxE9dcVPyNTBzLJsNCk9RpZ`.

2026-10-17: **released `ee821c0`** (portraits v2, failure copy, image limits, 8 jobs per user / 16 videos
overall, plus the 2026-10-16 merges). Railway API `29e6134f`, generation `8ba0b263`, export `f7bdca38`,
scheduler `e001f0e4`; migrations 60 -> 62 (owner, `assets.0005`, `assets.0006`); `portraits_cutover` removed
28 old BytePlus groups / 46 assets and retired 239 `portrait_assets` rows; `VEEVEE_MANAGED_PORTRAITS=1` on API,
generation and scheduler; `settings.maxConcurrentJobs` = 8; Vercel `dpl_CZA4uTxE9dcVPyNTBzLJsNCk9RpZ`.
Rollback targets: Railway api `5fb7579d` (flag off, same image) or `bb17da6d` (pre-release; needs the
`managed_portraits_rollback` first, migrations are at 62), generation `1c01462b`/`c3ad599f`, export `04df8e9e`,
scheduler `bbc4ebd2`/`86fc3d69`; Vercel `dpl_qgFuZGXbXE8LKPAqJYjX8Ktj7PNC`. Old portraits cannot come back.
Pending: owner face canary (paid Seedance job with a face reference); confirm the BytePlus account allows 16
concurrent Seedance tasks.

**Incident 2026-10-17 08:16-08:19 UTC (about 3 min):** `/api/*` on veevee.ai returned 503
`BACKEND_ROUTING_UNAVAILABLE` after the first frontend deploy. Production deployments had received
`DJANGO_API_ORIGIN` and `GOAL4_PRIVATE_INGRESS_SECRET` per deployment from a private file left on the old Mac;
the project only had them for Preview. Rolled back to `dpl_qgFu...`, then added both as encrypted Production
project variables (values derived from the Green API configuration, identical to Preview), built with
`--skip-domain`, verified the deployment with `vercel curl`, then promoted. Future frontend deploys need no
private file; always deploy with `--skip-domain`, verify, then promote.

2026-10-15: the generation worker now runs the versioned image (`a3b5d12`, release above). Any
later worker deploy from this branch carries the Magnific code; keep `VEEVEE_MAGNIFIC_UPSCALE` set.

2026-10-14: no deploys (owner). Managed portraits are ready for an approved rollout per
`managed-portraits.md` after the generation-worker redeploy and the BytePlus cleanup decision.

No deploys on 2026-10-13 (owner). Next: with owner approval, redeploy the generation worker from a
commit that has both gate passes (latest: `f61caef`), at an idle moment, then watch the first jobs.
Pending owner decisions: BytePlus quota (free 51 archived remote assets vs raise quota), paid canary
budget, A4 credential rotation, A5 Blue shutdown, frontend follow-up (library-full banner,
character-delete copy).

## Inherited open items (August 2026 remediation tracker, not re-verified)
The tracker was retired with the migration docs (see `docs/README.md`). These rows were not
`resolved` there; several describe the Vercel/Node or GCP era and may no longer apply. Triage before
acting on any of them.

| ID | Item | Tracker state | Last verified |
|---|---|---|---|
| SEC-01 | Exposed AWS access key is unrotated | monitoring | 2026-09-04 |
| SEC-05 | Higgsfield refresh has no distributed lock | in_progress | 2026-09-01 |
| SEC-07 | No Content-Security-Policy | open | 2026-08-18 |
| COST-01 | Duplicate S3 history remains billed | monitoring | 2026-09-03 |
| COST-03 | No CDN in front of GCS | open | 2026-08-18 |
| COST-07 | Pricing rows contain unverified placeholders | open | 2026-08-18 |
| REL-01 | Dead depth worker strands a running job | in_progress | 2026-09-04 |
| MIG-04 | Cloud SQL is staged but not live | in_progress | 2026-09-01 |
| MIG-05 | Cloud CDN is not provisioned | open | 2026-08-18 |
| MIG-06 | Rollback credentials were never removed | monitoring | 2026-09-03 |
| VER-04 | Depth worker lacks end-to-end production/GPU verification | open | 2026-08-29 |
| VER-07 | Thumbnail warm-up was never run | open | 2026-09-01 |
| VER-08 | Kling 2K reference rule lacks controlled probe | in_progress | 2026-09-01 |
| VER-09 | Seedance continuation relies on third-party evidence | open | 2026-08-18 |
| VER-10 | Kling seed support is unconfirmed | in_progress | 2026-09-01 |
| VER-12 | Audio surcharge pricing lacks invoice verification | open | 2026-08-18 |
| ARCH-01 | API responses use multiple envelopes | open | 2026-08-18 |
| ARCH-02 | Storage module contains dual provider branches | deferred | 2026-08-25 |
| ARCH-05 | Generation failures return HTTP 200 | monitoring | 2026-08-29 |
| ARCH-06 | Zustand store is oversized | deferred | 2026-08-25 |
| ARCH-07 | Admin dashboard component is oversized | deferred | 2026-08-25 |
| QUAL-01 | Video scaffolding is reasoned, not bake-off measured | open | 2026-08-18 |
| QUAL-02 | Eval harness has no fixtures or CI gate | open | 2026-08-18 |
