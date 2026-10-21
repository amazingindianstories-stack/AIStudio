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

## Generation worker queue fix (code only, not deployed)

The generation entrypoint now defaults to four execution slots through
`VEEVEE_GENERATION_WORKER_SLOTS` (optional integer override, 1-8). Its persistent pool
refills each freed slot without waiting for an entire batch, giving due video and upscale
submits and polls the slot ahead of image jobs (oldest first within each group). Admission limits, provider
lanes and the 120-second deployment drain remain unchanged. Admissible queued image
and video cards show "Waiting for a free worker slot" while all execution slots are busy.
Production continues to use its deployed commit until a separately approved release.

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
- Hardened (`a3b5d12`) for large media on the 2 GB generation worker (the deployed entrypoint selected one slot): image results stop at
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

**Fixed in code 2026-10-19 (branch `fix/unblock-production-features`), not deployed.** Each route had
more than one layer blocking it:
- Audio transcription: gateway; the paid guard refused the worker's Gemini POST (audio bypasses
  `execute_admitted`); the view created its row without `reserve()`, so worker RLS hid it (requests
  ended in a 504 "still pending"). Now: the API registers the intent in the transaction that creates
  it, the worker claims RESERVED→ATTEMPTING only after its own never-replay claim committed, and the
  single POST must be the configured model's `generateContent` with this job's exact snapshot bytes,
  MIME and prompt (ATTEMPTING→SUBMITTING). A refused claim provably sent nothing and ends the row.
- Admin agent chat (admin-only, no job row): gateway; paid guard. Now: a dedicated
  `AgentTransport` (exempt like the BytePlus asset transports) that allows only POST
  `generateContent` on `AGENT_LLM_MODEL` (default `gemini-flash-latest`) with the agent's own system
  prompts and tool sets, no generation config, bounded body.
- Admin users/pricing/limits/user-limits and the read-only dependency status: gateway only. Django
  answers 401 without a session and 403 for a non-admin.
- Still closed: runtime audit (writes rolled-back fixtures into the live database and runs the
  executor; MIG-04 assumes Cloud SQL), Higgsfield token seeding (no Higgsfield model is offered; it
  stores a provider credential), the retired schema endpoint, webhooks, queue execute, worker export
  access. The dashboard shows the first two as off instead of failing.
- No production variable changes are needed.

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
2026-10-20 ~08:50 UTC: **released `main` `0eb5a6e`** (#93 Kling Image 3.0 / 2.1 behind `VEEVEE_KLING`; #94 exact
provider errors in artists' messages plus the admin Errors tab at `/api/admin/errors`). Release gate and rehearsal
passed on the commit. Railway api `1d302de7`, generation `41e981ea`, export `3516a6ec`, scheduler `df1fc5d1`; Vercel
`dpl_4cxqGjvoNGLyaThDMEeCTC8KUCcH` (built with `--skip-domain`, verified with `vercel curl`, promoted 08:49:55).
Deploy order was generation, api, export, scheduler, so the api never admitted a Kling job an old worker would refuse.
Variables (names only): `VEEVEE_KLING=1` on api and generation, `KLING_API` on generation only; `KLING_API_HOST` unset.
No migrations. Rollback targets: api `201c65aa`, generation `cf500cfb`, export `65974829`, scheduler `a4e6b1e1`,
Vercel `dpl_7fhSdebmD9TA8VjCoERgPmdb3Bqi` (the `8b3e02a` set; that code ignores the Kling variables).
- **Failed first generation attempt (08:19-08:22 UTC):** deployment `96d3ad42` crashed at startup with
  `ModuleNotFoundError: No module named 'config'` and was rolled back to `cf500cfb` (as `55b5687e`, same image). The
  staging directory sat inside another Git checkout whose `.gitignore` has an unanchored `config/` rule; `railway up`
  applied it and dropped `backend/config/` from the upload. Restaged outside any Git checkout (no ancestor ignore
  files, `backend/config/settings` present) and redeployed. No job was queued; the worker was absent about 2 minutes.
  **Stage `railway up` directories outside every Git checkout.**
- Verified: api readiness, `/api/health` 200 through `www.veevee.ai`, signed-out `/api/admin/errors` 401, no 5xx after
  the api switch; a queued Seedance job finished before the worker switch and the next Seedream job succeeded across
  it; scheduler leases renewing. Both production domains are in the Green browser origins (all HTTPS, no wildcard);
  the owner's signed-in tab sent CSRF-protected `POST /api/generate/image` requests through the new frontend (200).
  The Errors data lists the three 2026-10-19 Seedance `InputAudioSensitiveContentDetected` failures (HTTP 400, blamed
  input and request id kept), whose messages now name the provider code. The old api deployment reads CRASHED only
  because the entrypoint exits 1 after a graceful SIGTERM shutdown.
- Memory (current / peak / limit): before the deploy api 2.33 / 2.46 / 4 GB (1.65 GB the evening before: still
  climbing about 0.7 GB a day), generation 0.73 / 1.01 / 2 GB, export 0.08 / 0.21 / 0.5, scheduler 0.10 / 0.11 / 0.5;
  at 09:05 api 0.24, generation 0.13, export 0.06, scheduler 0.08 GB. Keep watching the api.
- **Kling canaries blocked by the Kling account:** the owner's Kling Image 3.0 and 2.1 jobs (2K, 21:9) each got one
  create POST answered HTTP 429, code 1102 "Account balance not enough" (prepaid resource pack depleted or expired;
  the same answer hit two jobs on 2026-09-05; last Kling successes 2026-08-17 / 08-19). The Bearer key was accepted
  (auth errors are 1000-1004), the ledger ended in `SUBMITTING`, no task was created, no retry, nothing billed (spend
  totals count only succeeded rows). The result host is still unconfirmed. Artists see the busy copy for 1102
  (`failure_copy.py`), which is misleading for an unfunded account.
- **Kling switched off ~09:03 UTC (owner):** `VEEVEE_KLING=0` on api and generation (`KLING_API` kept; it is inert
  while the flag is off), same images redeployed: api `e4de5376`, generation `dc65f58a`. Both Kling models are refused
  at enqueue ("Kling Image 3.0 is not enabled. Choose another image model."). Rollback targets for this step: api
  `1d302de7`, generation `41e981ea`.

**Re-enable Kling:** top up or renew the Kling resource pack; set `VEEVEE_KLING=1` on api and generation and redeploy
(generation first, then api); run one Kling Image 3.0 2K and one Kling Image 2.1 1K job from a signed-in session;
confirm one create POST each, ledger `SUBMITTING`, and a result host of `h1.inkwai.com` or `cdn.klingai.com`. Any other
host needs an allowlist code change and deploy.

2026-10-19: **Kling Image 3.0 / 2.1 merged to `main`, not released (flag off).** Production had no Kling key and
the paid guard refused every Kling job ("Only configured Gemini or Seedream image providers authorized"). Kling is
now admitted only with `VEEVEE_KLING=1` on API and generation, pinned to the one create endpoint on the Kling host
and to the job's own model code, `n=1`, ratio and size; with the flag off the composer's Kling choice is refused at
enqueue as "Kling Image 3.0 is not enabled". `KLING_API` (Railway variable on generation only; the API never holds
it) and an optional `KLING_API_HOST` (a `*.klingai.com` origin, else startup is refused) reach Django only while
the flag is on. Result hosts `h1.inkwai.com` (Kling's API reference example) and `cdn.klingai.com` (published sample
responses) join the generation worker's media allowlist with the flag; neither is seen live yet, and on
2026-10-15 Magnific image and video results came from different hosts, so the first live canary must confirm the
real host (an unlisted host leaves the job running and re-polling until the allowlist is fixed). Also: a Kling
image whose poll or download was interrupted after Kling accepted it now resumes polling without a claim (the
guard used to refuse the resume and leave it running forever), and Kling images no longer count in or wait on
the Gemini spend window. Before setting the flag: one owner-approved live canary per model (about $0.03 each).

2026-10-19 ~09:30 UTC: **released `main` `8b3e02a`** (#91: audio transcription, admin agent chat, admin user/limit/
pricing changes and Status unblocked; runtime audit and Higgsfield token seeding stay closed). Release gate and
rehearsal (89/89) passed on the merge commit. Railway api `201c65aa`, generation `cf500cfb`, export `65974829`,
scheduler `a4e6b1e1`; Vercel `dpl_7fhSdebmD9TA8VjCoERgPmdb3Bqi`. No variable changes (`VEEVEE_GEMINI_OMNI=1` kept).
Queue was empty. Signed-out probes through veevee.ai: transcribe/admin routes reach Django (401), runtime audit and
set-token refused by the gateway (403). Pending: first real transcription and agent message (only fakes so far).
Rollback targets: api `0182d113`, generation `ecaca500`, export `49383387`, scheduler `73b333ed`, Vercel
`dpl_H2HM8MQuUaTh4McsPpFBkoUDza2V`.

2026-10-19 ~05:22 UTC: **released `main` `4e7a915`** (#86 rate-limit hardening + memory fix, #87 Gemini Omni
Flash 1.1, #88 viewer navigation, #89 favourite star). Release gate and local rehearsal passed on the commit.
Railway api `622f8afa`, generation `9c46f08b` (after the flag: `0182d113`, `ecaca500`), export `49383387`, scheduler `73b333ed`; Vercel
`dpl_H2HM8MQuUaTh4McsPpFBkoUDza2V` (built with `--skip-domain`, verified with `vercel curl`, promoted). No
migrations, no variable changes. One queued Seedance job went through the worker switch and succeeded.
~05:50 UTC: owner-approved live probe of `gemini-omni-1.1-flash` (4 s, 360p, from the generation service) completed in ~21 s with an inline MP4 in `steps[].content` (the shape `omni.extract_video` reads); then `VEEVEE_GEMINI_OMNI=1` set on api (`0182d113`) and generation (`ecaca500`), same image. Flag rollback: unset it. Rollback targets: api
`e48952f3`, generation `c1a4f34b`, export `1c4c5afe`, scheduler `a1a04621`, Vercel
`dpl_CJvLGB5Woi3nSpaTeTaM3DdWciSs`. Pending: watch Railway memory on generation and API for a day.

2026-10-18: **context-aware viewer navigation merged to `main`, released 2026-10-19.** The viewer's arrow keys walk the
list it was opened from (the grid's folder/Unsorted/filter scope in grid order, a chat thread, or nothing for a
lone card), continue into the next keyset page of the same scope instead of wrapping early, and Up/Down follow the
card's column again. The thumbnail shows at once and neighbours are resolved in one batched `media-resolve` and
warmed from direct storage URLs (images only; video masters are never prefetched), so stepping adds no per-step
`/api/media` traffic through Vercel. Real GCS signed URLs are verified only after deploy.

2026-10-18: **Gemini Omni Flash 1.1 merged to `main`, released 2026-10-19 (flag still off).** Google shuts `gemini-omni-flash-preview`
down on 2026-10-22 (replacement `gemini-omni-1.1-flash`, GA 2026-08-27). The old model is retired (new jobs
refused with a clear message; history still renders and counts in the Gemini spend window). Omni video never
passed the paid guard in production; 1.1 is admitted only with `VEEVEE_GEMINI_OMNI=1` on API and generation,
pinned to the Interactions create endpoint and the job's own ratio/size/length. 360p/720p, 4-10 s, 11 estimator
cents/s at 720p. Before setting the flag: one owner-approved live probe (4 s 360p, about $0.14).

2026-10-18: **rate-limit hardening merged to `main`, released 2026-10-19.** Audit of every provider and our own API: Gemini 429s no
longer retry inside the job (the paid guard refused the retry and users saw a generic error after ~33 s);
provider overload codes show the busy copy; a Seedance job whose output download fails frees its lane slot and
gives up after 6 h; our own slow-call 429 is retried by the client and slots are half the API threads; portrait
assets are refused only for image-content errors and a stuck image no longer blocks the upload queue; worker and
scheduler loops survive database errors; `MALLOC_ARENA_MAX=2` plus a per-job `malloc_trim` stop the memory
ratchet (generation worker reached 1.84 GB of 2 GB, API 2.5 GB of 4 GB, released only by deploys). Watch Railway
memory after the next deploy. The local fake provider server takes `/control {"faults": [...]}` to replay limits.

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
