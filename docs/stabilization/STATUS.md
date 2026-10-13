# Veevee stabilization — status

Spec: `Veevee_stabilization_revised_agent_plan.md` (P0–P6). Branch `stabilization/2026-10-13`
(worktree `../veevee-stabilization`, from `d9ef939`). The pre-existing uncommitted tree is preserved
unchanged in the owner's checkout and snapshotted as local branch `wip/django-consolidation-2026-10-13`
(`2791f02`). Private artifacts (backups, launcher bytes, env value hashes) live in the owner's private
root `…/goal4-private/stabilization-2026-10-13/` (0700/0600, FileVault on) — never in Git.

**The GitHub repository is public.** Nothing in this file or any commit may contain secrets,
connection strings or private hostnames. Local commits are not pushed without owner approval.

**Testing rule (owner, 2026-10-13):** every stability check and every change is tested locally or on a
preview build first. Production only receives a release after it has passed there and the owner approves.

Legend: PASS · FAIL · NOT VERIFIED · PENDING (not started) · BLOCKED (needs owner approval)

## Phase summary
| Phase | State | Notes |
|---|---|---|
| P0 Baselines / rollback | PASS (rollback execution NOT VERIFIED) | see below |
| P1 Git baseline | IN PROGRESS | P1.1, P1.3 PASS; backend suite PASS |
| P2 Correctness fixes | PENDING | |
| P3 Versioned image + cutover | PENDING (cutover = gate A1) | |
| P4 Media off Vercel | PENDING (release = gate A2) | |
| P5 UI perf + copy | PENDING (release = gate A3) | |
| P6 Retire Blue | PENDING (gate A5) | |
| Credentials | BLOCKED (gate A4) | Higgsfield token exposed |

## P0 — Baselines and rollback (2026-10-13)
| Gate | State | Evidence |
|---|---|---|
| P0.1 Live baseline captured | PASS | Launcher bytes for api/generation/export/scheduler with SHA-256 (api inner `963f2e3b…`, generation `7c533dc5…`, export `5434d153…`, scheduler `c69fd589…`); deployment IDs api `488d4b18`, generation `1bdedd40`, export `1979e20d`, scheduler `0cd7ab06`; image digests (api `sha256:08fc8065…`, generation `sha256:87388045…`, export `sha256:15eadb0f…`, scheduler `sha256:fa5d4e90…`); start commands; limits; env names + value hashes; Vercel production `dpl_5wVSa2cH…` (`782d0bd`). |
| P0.1 Dependency trace | PASS | Green variables reference no Blue host and not `image-video-project.vercel.app`. **Finding F-01:** generation/scheduler `app_origin` and API `GOAL4_PREVIEW_APP_ORIGIN` point to an old `aistudio-v1-*.vercel.app` preview deployment, not `https://veevee.ai` (fix in P3). **Finding F-02:** API launcher env sets `LOCAL_DATA_MODE=fixtures`, `MOCK_GENERATION=1`, `MOCK_ASSET_PROVIDER=1` for the API process (worker runs real providers) — make explicit in P3 settings. |
| P0.2 Green backup | PASS | `pg_dump` 18.6 custom format, 12,972,198 B, sha256 `c7985b5d…`, transfer hash match; globals without passwords. |
| P0.2 Restore + compare | PASS | Restored into isolated local PG 18.4 (socket only). Identical to production: `django_migrations` 60 rows incl. UTC applied timestamps (md5 `e58cd488…`), columns 266, indexes 94, constraints 246, functions 25. Minor-version gap 18.4 vs 18.6 noted. |
| P0.2 Media baseline | PASS | 3 Seedance 2.5 originals `video/quicktime` `.mov` (20.6/13.2/14.9 MB), 2 Seedream PNGs, 1 reference upload — SHA-256 recorded privately. |
| P0.3 Blue backup + restore | PASS | Blue production `pg_dump` 18.6, 11,152,527 B, sha256 `8946cf0c…`, restored: 31 tables, 6,650 generations, 18 users. Last Blue write 2026-10-12 11:14 UTC. |
| P0.4 Rollback set | NOT VERIFIED (documented, not executed) | Per service: deployment ID + image digest + start command + exact variable values (private, hash-pinned). Mechanism: restore variables from private snapshot with `railway variable set --skip-deploys`, then `deploymentRollback`/redeploy of the recorded deployment. Executing it would change production. |
| P0.5 Metrics baseline | PASS | Railway 24 h: API mem peak 1.17 GB / avg 0.44, CPU avg 0.015; HTTP 200 38,736 · 307 27,537 · 404 155 · 401 80 · **502 29** (pre memory raise); generation mem peak 0.98 GB; export 0.07; scheduler 0.15; postgres 0.35. Estimated usage: **Blue ≈5.5× Green memory and ≈6× disk**. Vercel 7 d: effective ≈$0.05–0.10/day (function invocations + origin transfer), billed ≈$0. |
| P0.6 Credential quarantine | PASS (rotation BLOCKED) | Access-key CSV moved from `docs/` to private quarantine. Public-history scan (360 pushed commits): `.higgsfield-mcp-token.json` committed in 3 commits (`e698cbd`, `aa504cc`, `5dfec61`) and also included in the 2026-10-13 review zip → **rotate (gate A4)**. One DSN in `.env.local.example` history is a placeholder. No Google/AWS/OpenAI/private-key patterns found in pushed history. |

### Rollback thresholds (apply to every live step)
Abort and roll back if any of: API 5xx > 1% over 10 min or any 502 burst > 5/5 min; any OOM kill;
memory > 85% of limit for 10 min; generation lease/queue item older than 30 min without progress;
login failures > 3× baseline; media 403/404 > 2× baseline; any duplicate provider submission.

## P1 — Git baseline
| Gate | State | Evidence |
|---|---|---|
| P1.1 Applied migration graph in Git | PASS | **Finding F-03:** production's applied app migrations are the 26 `*_railway_v2_*` / `0001_uploadsession` / `0002_generation_submission_input` / `0004_uploader_provenance` files that existed **only inside the deployed image** — neither HEAD's 49 files nor the WIP tree's 26 recreated `*_baseline_*` files. 16 further `django_migrations` rows are legacy history with no files (ignored by Django, preserved untouched). Branch rebased onto the WIP snapshot (which matches the image's application code) and the image's migration files restored verbatim. Backend now byte-identical to the deployed image for all 291 image files. Against the restored Green clone: `migrate --plan` → "No planned migration operations"; `makemigrations --check --dry-run` → "No changes detected"; 26 applied / 0 unapplied. |
| P1.2 Bring forward intended edits | PASS | Branch is rebased on the WIP snapshot, whose application code is byte-identical to the deployed image (291/291 files after migration restore). |
| P1.3 Deployed frontend imported | PASS | `1950972`: exact Vercel `782d0bd` source (179 files, all byte-identical). Test-contract fixes `c12c31f`: middleware tests set the server-only ingress value and assert caller headers are replaced + fail-closed; unresolvable `asset://` → no display URL; API inventory fixture added. `npm test` 440/440, `eslint src --max-warnings=0` clean, `next build` OK. |
| Backend suite | PASS | Local venv + isolated PG 18.4: 586/590 (4 need libvips/pyvips, absent locally). Production-equivalent image built from `backend/Dockerfile` (Python 3.12, ffmpeg, libvips) + disposable `postgres:18.6`: 588/590; the 2 errors need repo `scripts/` and Node, absent from the image, and pass locally. Every test passes in at least one faithful environment. |
| P1.4 Overlay inventory + contract tests | PENDING | |
| P1.5 Node remnants | PASS (already removed on WIP base) | Live frontend imports none; routing tests confirm no Node fallback. |

**Finding F-04 (production bug, depth maps):** the Green ingress gateway rejects every depth-worker
route (`POST /api/worker/depth/{claim,heartbeat,progress,upload-url,complete}`) and artist depth
enqueue/status (`/api/generate/depth`, `/api/generate/depth/status`) with
`PREVIEW_OPERATION_DISABLED`/`PREVIEW_PAID_PROVIDER_DISABLED` (403), and the API process has no
`DEPTH_WORKER_TOKEN`. Depth has been unusable since the Green cutover. Hotfix prepared privately
(gateway allowlist + token pass-through, launcher inner sha `287ca2fc…`); allowlist unit-checked.
Depth enqueue writes rows directly (`apps/workers/views.py`) and never reaches paid providers.
Deployment needs owner approval (gate **A0-depth**).

## Owner approval gates
- **A0-depth** Depth hotfix: gateway allowlist for depth routes + `DEPTH_WORKER_TOKEN` (value from the existing depth-worker config, never printed) on the Green API, then API redeploy.
- **A1** Green cutover to versioned image (P3), one service at a time.
- **A2** Bucket CORS + direct-media release (P4).
- **A3** Frontend release(s) (P5).
- **A4** Credential rotation: Higgsfield token (public history + zip), BytePlus ARK key and Google API key (exposed in a session log), deactivate the quarantined access key, verify the DB passwords in `docs/goal4/tools/qualify-green-private-auth-*.py`.
- **A5** Blue shutdown (`railway down`, no deletion), pause Vercel `image-video-project`, remove unused Vercel secrets.

## Next safe action
P1.3 — import the exact deployed frontend source; then P1.4 overlay inventory with contract tests.
