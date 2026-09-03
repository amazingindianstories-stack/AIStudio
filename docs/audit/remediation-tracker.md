# Lumina Studio remediation tracker

Canonical source: `Lumina-Studio-Issues-and-Remediation-Plan.pdf` (18 August 2026).
This tracker deliberately keeps the PDF's 80 stable IDs. Update the relevant
row in the same commit as every remediation change; never record credentials,
secret values, or sensitive object names here.

States: `open`, `in_progress`, `blocked`, `monitoring`, `resolved`, `deferred`.

## Active P0 queue

| ID | State | Owner | Last verified | Evidence | Next action / exit gate |
|---|---|---|---|---|---|
| SEC-01 | in_progress | AWS administrator + Codex | 2026-09-03 | Vercel Production and Preview now use the verified exact-bucket read-only identity; immutable redeploys are Ready and production media checks pass. The two old `vercel-s3-access` keys remain active pending the final consumer check and deactivation. | Confirm CloudTrail shows no other consumer, deactivate both old keys, then delete them after the observation window. |
| SEC-02 | resolved | Codex | 2026-08-25 | `.env.production` was deleted without reading or printing its values. | Future `vercel env pull` output is restricted to a mode-0600 file under `/tmp` and removed immediately. |
| SEC-03 | resolved | Codex | 2026-08-25 | The built-in `postgres` password was replaced with a 48-byte random unretained value; the exposed literal is rejected, the runtime IAM principal passed read and rolled-back write checks, and the temporary impersonation grant was removed. | Keep administrative access on IAM or perform another controlled password reset; never store the built-in password in application configuration. |
| COST-01 | monitoring | AWS administrator + Codex | 2026-09-03 | All 122 inventory gaps copied; the full comparison reports 2,943 same and zero missing/different/failed. The restore drill passed with zero temporary residue. | Observe through 2026-09-10, capture final inventory evidence, then empty and delete only `ais-film-platform-media`. |

## Held / operator-attention queue

These items are deliberately outside the 2026-08-27 safe release. Their state
in the full register remains authoritative; this view only makes the holds easy
to resume after the deployable work is stable.

| ID | Why held | Resume gate |
|---|---|---|
| SEC-01 | Two legacy full-access keys remain active while their CloudTrail consumer check awaits operator confirmation. | Confirm no other consumer, then deactivate both old keys; delete them after the observation window. |
| COST-01, MIG-06 | Zero-gap and restore gates pass; the seven-day observation window started 2026-09-03. | Verify media delivery, fallback activity, and referenced-object coverage through 2026-09-10 before removing rollback resources. |
| REL-01, VER-04 | Requires one coordinated Vercel, Django, and GPU-worker protocol rollout. | Schedule the worker update and deliberate-kill/all-encoder exercise together. |
| ARCH-05 | Alert creation changes Vercel project configuration. | Configure the stable event-marker alert after log shape is observed. |

## Local product bugs outside the PDF register

These IDs track user-reported product defects without changing the PDF's fixed
80-ID register. `ready_for_deploy` means locally implemented and verified, not
production-confirmed.

| ID | Bug | State | Last verified | Evidence / next action |
|---|---|---|---|---|
| UI-LOCAL-01 | Media-card actions overlap and execute without confirmation | resolved | 2026-09-02 | Disposable Chrome and Safari runs covered all eight confirmation categories, including saved-asset deletion. Every dialog opened with Cancel focused, only Cancel was used, aggregate fixture counts remained unchanged, and no provider task or billed operation was created. PR #26 passed protected checks and its exact merge reached a Ready production deployment before closure. |
| UI-LOCAL-02 | Asset viewer can leave all mouse/keyboard input wedged after arrow navigation and Escape/close | resolved | 2026-09-02 | Real Chrome and Safari native-fullscreen runs kept arrow navigation on the active video, exited fullscreen safely, unmounted the viewer, and accepted subsequent composer input. PR #26 bounded Safari paint settling, consumed its replayed Escape, removed the teardown's exit-animation dependency, passed protected checks, and reached a Ready production deployment before closure. |
| UI-LOCAL-03 | Generation settings remain open with stale controls after switching Image/Video mode | resolved | 2026-09-02 | Disposable Chrome reproduced the stale cross-mode menu, then verified that both composer variants reset only the settings dropdown when mode changes. PR #28 passed strict `web`, `database`, and Vercel preview checks; merge `95a9ca5` reached a Ready production deployment before closure. |
| UI-LOCAL-04 | Narrow mobile header overlaps Agents and Open assets controls | resolved | 2026-09-02 | Disposable Chrome measured overlapping hit rectangles at 390px, then verified separated controls and the correct assets drawer action at 390px and 320px. Icon-only navigation now has accessible names. PR #28 passed protected checks and merge `95a9ca5` reached a Ready production deployment before closure. |
| UI-LOCAL-05 | Board metadata failure leaves the canvas permanently loading with no recovery action | resolved | 2026-09-03 | Disposable Chrome reproduced the failure by stopping only the isolated PostgreSQL fixture database during a project switch. The Board now exposes a keyboard-focusable retry, keeps stale responses fenced, and recovers to the correct project and board after PostgreSQL returns. PR #30 passed protected checks; exact merge `b182f32` reached Ready production deployment `dpl_1281HZxF3aTNwCrAwytQ7ZA2cXYA` on the public aliases before closure. |
| UI-LOCAL-06 | Admin Logs, Activity, and Pricing columns are clipped and unreachable on narrow screens | resolved | 2026-09-03 | At 390px, disposable Chrome measured 947px and 768px Logs/Activity tables inside 356px containers with hidden horizontal overflow; Pricing was clipped too. All three now expose horizontal scrolling with stable table widths, while filters, pagination, dialogs, and local-only edits still pass. PR #30 passed protected checks and exact merge `b182f32` reached the Ready public production deployment before closure. |

## Full issue register

Rows not individually re-audited since the source review remain `open`; this is
intentional and prevents an old implementation claim from being mistaken for
current verification.

| ID | Title | Sev | State | Last verified | Owner | Evidence / next action |
|---|---|---|---|---|---|---|
| MERGE-01 | Finished style-drift work was unmerged | P1 | resolved | 2026-08-25 | Codex | Merged in `2b6446b` and deployed before the Seedance limit release. |
| SEC-01 | Exposed AWS access key is unrotated | P0 | in_progress | 2026-09-03 | Read-only replacement is live in Vercel Production and Preview; deactivate the two inventoried legacy full-access keys after the consumer check, then delete them after observation. |
| SEC-02 | Plaintext `.env.production` secret dump | P0 | resolved | 2026-08-25 | Codex | Local export deleted; temporary-file-only policy recorded above. |
| SEC-03 | Cloud SQL superuser password committed by setup script | P0 | resolved | 2026-08-25 | Codex | Random unretained password set; old literal rejected; IAM read/write access verified; temporary grant removed. |
| SEC-04 | Route auth relies on every handler checking the session | P1 | resolved | 2026-08-25 | Codex | Route-auth guard shipped in `6fa858a`. |
| SEC-05 | Higgsfield refresh has no distributed lock | P1 | in_progress | 2026-09-01 | Codex | Refresh coordination is deployed and its PostgreSQL lease test passes. The latest authenticated Admin Status check still reports that the stored access token is not fresh and refresh was not triggered, so the one-natural-rotation exit gate remains unproven; no refresh was forced. |
| SEC-06 | Canvas upload ignored board ID | P2 | resolved | 2026-08-25 | Codex | Board validation shipped in `2929509`. |
| SEC-07 | No Content-Security-Policy | P2 | open | 2026-08-18 | Unassigned | Schedule after final CDN domain is known. |
| SEC-08 | Dead Vercel credentials remain | P2 | resolved | 2026-08-29 | Operator + Codex | Removed only the eight verified-unused Blob and Higgsfield dev-API variable names from Vercel Production/Preview; a post-change name-only inventory confirms they are absent while the separate Production MCP compatibility credentials remain. |
| COST-01 | Duplicate S3 history remains billed | P0 | monitoring | 2026-09-03 | See active P0 queue; deletion remains gated on seven stable days and final evidence. |
| COST-02 | DB-referenced objects are missing from GCS | P1 | resolved | 2026-09-03 | A fresh production scan checked all 7,983 referenced objects against 17,603 stored GCS objects and reported zero missing after the 122-object inventory migration. |
| COST-03 | No CDN in front of GCS | P1 | open | 2026-08-18 | Unassigned | Provision CDN before removing the S3 fallback. |
| COST-04 | Media delivery can silently proxy bytes | P1 | resolved | 2026-08-29 | Operator + Codex | An authenticated production Admin Status run returned `OK` for Media Delivery after a real recent media object completed a direct one-byte read with HTTP 206; the object identity stayed redacted and no proxy fallback occurred. |
| COST-05 | Video best-of-N can bill after partial failure | P2 | resolved | 2026-09-03 | Codex | Production runtime audit on Ready deployment `dpl_BRrqiE8qqrh2HqCTCLmEz9FuarLG` exercised the deployed submission library with a controlled 2-of-3 acceptance: both accepted task IDs survived, estimated cost was prorated to 2/3, and the injected submitter made no provider request. PR #32 passed strict `web`, `database`, and Vercel checks before merge `ef9dbbe`. |
| COST-06 | Provider costs mix exact and estimated values | P2 | resolved | 2026-08-29 | Codex | Aggregate-only production verification found 1,955 succeeded estimated rows and 6 succeeded reconciled rows after deployment, proving both classes are persisted. Admin totals, user summaries, logs, and CSV exports expose the split. |
| COST-07 | Pricing rows contain unverified placeholders | P2 | open | 2026-08-18 | Unassigned | Reconcile one invoice month. |
| REL-01 | Dead depth worker strands a running job | P1 | in_progress | 2026-08-29 | Codex | The conditional depth batch was not started: an aggregate one-hour production-log check found zero worker heartbeat requests, and no operator worker terminal was available. Claim-fenced implementation `4301601` remains isolated; the deleted Django source will not be restored. |
| REL-02 | Best-of-N holds all full-resolution candidates in memory | P1 | resolved | 2026-09-01 | Codex | The post-PR #24 authenticated production audit again exercised the real serial spool library, retained metadata only, and removed both the success and forced-failure directories; the diagnostic reported zero fixture residue. |
| REL-03 | Queue execution lacks an internal pre-timeout abort | P2 | resolved | 2026-09-01 | Codex | The post-PR #24 authenticated production audit again proved a short internal deadline persisted terminal failure before returning and left zero generation residue. |
| REL-04 | Stale reaper threshold can drift below route timeout | P2 | resolved | 2026-08-25 | Codex | Literal comparison guard shipped in `6fa858a`. |
| REL-05 | Client scope and SQL scope can drift | P2 | resolved | 2026-08-27 | Codex | PostgreSQL scope/order/keyset parity passed on PR #11 and main CI run `33055388366` after the production migration chain. |
| REL-06 | `db:push` does not create indexes | P2 | resolved | 2026-08-27 | Codex | Production read-only catalog verification reports all 10 expected indexes present; the registry, optimizer, Admin Status check, and live-catalog CI test shipped in `8f216d9`. |
| REL-07 | Repeated poll errors can leave a row running forever | P2 | resolved | 2026-09-03 | Codex | Production runtime audit on Ready deployment `dpl_BRrqiE8qqrh2HqCTCLmEz9FuarLG` created one isolated task-backed video fixture, recorded a controlled transient poll failure through the shared reconciliation state machine, kept the row non-terminal, cleared poll health on the next pending provider response, and reported zero fixture residue. The diagnostic selector was restricted to its random fixture ID and no provider request was made. PR #32 passed protected checks before merge `ef9dbbe`. |
| REL-08 | Most providers trust requested aspect ratio | P3 | resolved | 2026-08-28 | Codex | Image outputs (Gemini/Nano Banana, Higgsfield, Kling) and video outputs (Higgsfield, Omni, BytePlus, including best-of winners) are measured from the same bytes used for persistence. The nearest model-supported ratio is stored; structured mismatch/inspection warnings and requested-ratio fallback keep metadata failures non-fatal. Synthetic image and local ffmpeg video fixtures pass. |
| REL-09 | Login-attempt cleanup is opportunistic | P3 | resolved | 2026-08-29 | Codex | A fresh unlogged 32-byte `CRON_SECRET` is set in Production. Deployment `dpl_89MM53UNUbuXpHS8ztsdCZjygsp5` returned HTTP 200 for one authenticated manual run, deleted 12 expired rows, and emitted the bounded structured `maintenance_cleanup` event; the temporary secret file was removed immediately afterward. |
| MIG-01 | Django port is not cut over | P1 | resolved | 2026-08-29 | Codex | The never-cut-over Django port was retired in favor of the production Next.js API; its complete tracked source remains recoverable in Git history. |
| MIG-02 | Live routes are missing from Django | P1 | resolved | 2026-08-29 | Codex | Eliminated with the retired secondary runtime; `src/app/api/` is the sole route implementation. |
| MIG-03 | Live tables are missing Django models | P1 | resolved | 2026-08-29 | Codex | Eliminated with the retired secondary runtime. Drizzle remains schema authority; no production table was dropped. |
| MIG-04 | Cloud SQL is staged but not live | P2 | in_progress | 2026-09-01 | Codex | The post-PR #24 authenticated diagnostic again confirms production uses direct PostgreSQL. The separate Cloud SQL cutover remains deliberately held because its prior connector-certificate failure requires an extended preview soak before another production attempt. |
| MIG-05 | Cloud CDN is not provisioned | P1 | open | 2026-08-18 | Unassigned | Choose hostname and execute the CDN runbook. |
| MIG-06 | Rollback credentials were never removed | P1 | monitoring | 2026-09-03 | Zero-gap, restore, rotated-credential, Production/Preview deploy, and direct-media gates pass. Keep fallback and AWS variables through the seven-day window ending 2026-09-10. |
| MIG-07 | Railway Django service does not exist | P2 | resolved | 2026-08-29 | Codex | The uncut-over Django deployment target was intentionally retired; the production Railway PostgreSQL database is unchanged. |
| MIG-08 | Higgsfield UI is gone but backend remains | P3 | resolved | 2026-08-29 | Codex | Decision recorded: the hidden Next.js MCP compatibility path remains supported for historical retry/readability, historical pricing remains, and the obsolete dev-API credentials are retired. |
| MIG-09 | Unreachable legacy agent routes remain in Django | P3 | resolved | 2026-08-29 | Codex | Removed with the retired Django source tree; the active Next.js agent surface is unchanged. |
| MIG-10 | Pre-Postgres JSON snapshots remain | P3 | resolved | 2026-08-28 | Codex | Read-only `git ls-tree -d origin/main data` verification at production `97b0e9c` found no root `data/` snapshot tree. No unrelated local or untracked file was deleted. |
| DRIFT-01 | Python video directive lacks reference legends | P1 | resolved | 2026-08-29 | Codex | The non-authoritative Python implementation and its cross-language parity guard were removed; the tested JavaScript directive remains authoritative. |
| DRIFT-02 | Django lacks video best-of-N pipeline | P2 | resolved | 2026-08-29 | Codex | Eliminated by retiring the uncut-over Django runtime. |
| DRIFT-03 | Django lacks server-side frame extraction | P2 | resolved | 2026-08-29 | Codex | Eliminated by retiring the uncut-over Django runtime. |
| DRIFT-04 | Python `crispen` is non-exact | P3 | resolved | 2026-08-29 | Codex | The dormant flag and non-exact Python implementation were removed with the Django runtime. |
| DRIFT-05 | Django GCS authentication differs and is unverified | P2 | resolved | 2026-08-29 | Codex | Eliminated by retiring Django; the deployed Next.js WIF/GCS path remains authoritative. |
| DRIFT-06 | Django media reads lack abort propagation | P2 | resolved | 2026-08-29 | Codex | Eliminated by retiring Django; the active Next.js media path retains abort propagation. |
| DRIFT-07 | Cross-language constants were hand-synced | P1 | resolved | 2026-08-25 | Codex | Constant parity guard shipped in `6fa858a`. |
| DRIFT-08 | JS and Python ZIP outputs lacked equivalence coverage | P3 | resolved | 2026-08-25 | Codex | ZIP parity guard shipped in `6fa858a`. |
| VER-01 | Django generation providers lack live calls | P1 | resolved | 2026-08-29 | Codex | Django will not ship, so billed verification of its removed provider copies is no longer required. |
| VER-02 | Django Higgsfield MCP path is unexercised | P2 | resolved | 2026-08-29 | Codex | The Django copy was removed without a paid call. The hidden Next.js Higgsfield compatibility path remains supported and unchanged. |
| VER-03 | Django agent path lacks a live Gemini turn | P3 | resolved | 2026-08-29 | Codex | Django will not ship; its legacy agent path was removed without a billed probe. |
| VER-04 | Depth worker lacks end-to-end production/GPU verification | P1 | open | 2026-08-29 | Codex | No heartbeat requests were present in the bounded one-hour production-log check and no worker terminal was available, so the all-encoder/kill exercise was not attempted. Resume only with a healthy worker and coordinated operator window. |
| VER-05 | Bundled ffmpeg is unverified on Vercel | P2 | resolved | 2026-08-29 | Operator + Codex | An authenticated production Admin Status run executed the bundled target-runtime binary and returned `OK` with its ffmpeg version line. |
| VER-06 | GCS signing under WIF is unconfirmed | P1 | resolved | 2026-08-29 | Operator + Codex | An authenticated production Admin Status run reached `aistudio-media-bucket` and returned `OK` after direct signed delivery of one byte from a real recent media object (HTTP 206), with no proxy fallback. |
| VER-07 | Thumbnail warm-up was never run | P2 | open | 2026-09-01 | Codex | The production database prerequisite is now reachable read-only through Railway's public endpoint, but the fresh combined reference/GCS scan stopped before listing objects because local application-default GCP authentication requires operator reauthentication. The last valid inventory remains 15,051 objects, 7,158 thumbnailable originals, 3,305 complete ladders, and 6,916 missing derivatives. No thumbnail apply or GCS write ran. |
| VER-08 | Kling 2K reference rule lacks controlled probe | P2 | in_progress | 2026-09-01 | Codex | The deployed validation-only diagnostic isolated the sole mismatch as `kling-v2-1[2k:i2i]`: 7/8 cases matched, 2/2 registered wire models routed safely, and no task was created. This option is already withheld from users. Validation-layer acceptance is not proof of a successful paid render, so the capability remains disabled and the finding stays open. |
| VER-09 | Seedance continuation relies on third-party evidence | P2 | open | 2026-08-18 | Unassigned | Run the bounded billed probe. |
| VER-10 | Kling seed support is unconfirmed | P3 | in_progress | 2026-09-01 | Codex | The deployed authenticated validation-only diagnostic again found valid- and invalid-seed responses inconclusive after the independent no-task invariant passed. Support remains disabled and no provider task was created. |
| VER-11 | Seedance 2.5 activation is unconfirmed | P2 | resolved | 2026-08-28 | Codex | Read-only production generation evidence contains 11 Seedance 2.5 rows: 9 succeeded and 2 failed. Successful provider completions prove the production account/model is activated, so the picker entry remains offered; no billed probe was run. |
| VER-12 | Audio surcharge pricing lacks invoice verification | P3 | open | 2026-08-18 | Unassigned | Reconcile an invoice. |
| ARCH-01 | API responses use multiple envelopes | P2 | open | 2026-08-18 | Unassigned | Address only with migration decision. |
| ARCH-02 | Storage module contains dual provider branches | P2 | deferred | 2026-08-25 | Unassigned | Delete the S3 branch after COST-01 rather than abstracting it. |
| ARCH-03 | Concurrency cap is global, not per user | P1 | resolved | 2026-09-01 | Codex | The post-PR #24 authenticated production diagnostic again exercised two isolated temporary sessions through the real queue route and passed per-user fairness, isolation, limit-override precedence, and zero-fixture cleanup. |
| ARCH-04 | Capabilities and prices key on display-name regexes | P2 | resolved | 2026-09-01 | Codex | The deployed validation-only diagnostic proved both registered wire models reached safe validation and that no provider task was created; sanitized case labels now isolate resolution mismatches without exposing provider bodies or identifiers. |
| ARCH-05 | Generation failures return HTTP 200 | P2 | monitoring | 2026-08-29 | Codex | Production logs still show a privacy-bounded `generation_failure` marker with `persisted:true` under HTTP 200. Vercel's native anomaly alert covers 5xx, not keyword-matched HTTP 200 markers; no authenticated dashboard/third-party keyword-alert installation path was available, so the alert exit gate remains open. |
| ARCH-06 | Zustand store is oversized | P3 | deferred | 2026-08-25 | Unassigned | Split only when touched for functional work. |
| ARCH-07 | Admin dashboard component is oversized | P3 | deferred | 2026-08-25 | Unassigned | Split only when touched for functional work. |
| ARCH-08 | Mutable module state sits outside stores | P3 | resolved | 2026-08-28 | Codex | Process-only poll IDs, timers/debounces, live-feed coordination, and request counters remain outside rendered Zustand state but now share `disposeStoreRuntime()` for logout, teardown, and isolated tests. The idempotent server reaper throttle has its own reset hook; ownership and durability boundaries are documented in `docs/runtime-coordination.md`. |
| DX-01 | Git history is bloated by research binaries | P2 | resolved | 2026-08-28 | Codex | Adopted the approved non-destructive shallow-clone policy: both GitHub Actions checkout steps explicitly use `fetch-depth: 1`. Historical rewriting remains intentionally out of scope. |
| DX-02 | ESLint configuration is missing | P2 | resolved | 2026-08-29 | Codex | ESLint 9's zero-warning gate passed the protected main CI run `33169539104` at production merge `a0114ce`; the Vercel deployment also completed successfully. |
| DX-03 | No CI gate | P1 | resolved | 2026-08-27 | Codex | PR #11 and main run `33055388366` passed web and PostgreSQL-backed Django jobs without billed probes. |
| DX-04 | Dead root `scratch.js` | P3 | resolved | 2026-08-25 | Codex | Deleted in `5c591a8`. |
| DX-05 | Setup script referenced the wrong bucket/deployment | P3 | resolved | 2026-08-25 | Codex | Deleted in `5c591a8`. |
| DX-06 | Documentation contains `.ts`/`.tsx` path drift | P3 | resolved | 2026-08-28 | Codex | Maintained documentation source references were converted to current `.js`/`.jsx` extensions and a unit-discovered guard now rejects retired `.ts`/`.tsx` source paths. |
| DX-07 | Django history paths in `CLAUDE.md` are stale | P3 | resolved | 2026-08-29 | Codex | Current guidance names the same-origin Next.js API as authoritative and labels the retained Django narrative as historical Git evidence. |
| DX-08 | Backend audit body presents resolved work as open | P3 | resolved | 2026-08-28 | Codex | The historical audit now begins with an explicit current-status rule linking the stable-ID tracker and warning that original recommendations are not live state. |
| DX-09 | Main auto-deploys with no preview gate | P2 | resolved | 2026-08-29 | Codex | Active GitHub ruleset `21794494` targets `main`: pull requests are required with zero approvals and resolved review threads, strict `web`, `database`, and `Vercel` checks are required, and deletion/non-fast-forward pushes are blocked. PR #15 exercises the gate. |
| DX-10 | Script-test naming convention is unenforced | P3 | resolved | 2026-08-27 | Codex | The runner's `scripts/**/*.test.js` rejection guard passed on PR #11 and main CI run `33055388366`. |
| DX-11 | Test discovery uses non-portable shell `find` | P3 | resolved | 2026-08-27 | Codex | Portable Node test discovery passed on PR #11 and main CI run `33055388366`. |
| QUAL-01 | Video scaffolding is reasoned, not bake-off measured | P2 | open | 2026-08-18 | Unassigned | Build fixtures before changing directives. |
| QUAL-02 | Eval harness has no fixtures or CI gate | P2 | open | 2026-08-18 | Unassigned | Commit at least ten representative fixtures. |
| QUAL-03 | Flagged-generation signal has no consumer | P3 | resolved | 2026-09-01 | Codex | The post-PR #24 authenticated production diagnostic again exercised the real flagged JSON and CSV review routes, passed RFC 4180 comma/quote/newline evidence, and verified zero fixture residue. |
| QUAL-04 | Depth progress uses coarse milestones | P3 | resolved | 2026-08-28 | Codex | Retained worker percentage, milestone count, and live timer; the card now labels the timer as elapsed (not remaining) and explains that depth estimation is normally the longest stage. No fabricated ETA was added because the vendored inference API exposes no per-frame callback. |
| QUAL-05 | Canvas asset project does not own board context | P2 | resolved | 2026-08-27 | Codex | Re-audit found the fix already present in `0b2c02b`: Canvas has an explicit board-project selector, clears the old board before switching, fences stale list responses, and labels the independent control `Assets from:`. A source guard now pins those invariants. |
| QUAL-06 | Supersampling has measured scene-accuracy risk | P3 | resolved | 2026-08-29 | Codex | Deleted the unused supersampling branch, downsampling helper, environment documentation, pricing override, and related comments. Gemini now always renders and persists the requested resolution; a source guard prevents the risky flag from returning. |

## Change log

- 2026-09-03: resolved `COST-02` and started the seven-day `COST-01`/`MIG-06`
  observation window. A Node 22 missing-only migration copied all 122 gaps;
  the complete comparison then reported 2,943 same and zero missing,
  different, or failed. A fresh production reference scan checked 7,983 keys
  with zero missing, and a temporary-path restore drill passed with zero
  residue. Vercel Production and Preview were rotated to the verified
  exact-bucket read-only identity and immutable redeploys reached Ready.
  Authenticated production status reported GCS reachable and direct media
  delivery HTTP 206; the post-rotation window had zero production 5xxs. The
  two inventoried legacy full-access keys remain active pending the final
  CloudTrail consumer check and deactivation; no fallback variable, AWS
  variable, user, key, or bucket was deleted. The register is 57 resolved and
  23 pending.

- 2026-09-03: resolved `COST-05` and `REL-07` only after PR #32 passed strict
  `web`, `database`, and Vercel preview checks, exact merge `ef9dbbe` reached
  Ready production deployment `dpl_BRrqiE8qqrh2HqCTCLmEz9FuarLG` on the public
  aliases, and the authenticated runtime audit returned `OK` for both checks.
  The partial-submission fixture retained both accepted tasks from a controlled
  2-of-3 result and prorated estimated cost without a provider request. The
  poll-recovery fixture recorded one transient error on its isolated production
  PostgreSQL row, remained non-terminal, recovered to pending, reset health,
  and reported zero residue. The same run left `SEC-05` in progress, `VER-08`
  at 7/8, and `VER-10` inconclusive. The register is 56 resolved and 24 pending.

- 2026-09-03: resolved `UI-LOCAL-05` and `UI-LOCAL-06` only after PR #30
  passed strict `web`, `database`, and Vercel preview checks and exact merge
  `b182f32` reached Ready production deployment
  `dpl_1281HZxF3aTNwCrAwytQ7ZA2cXYA` on the public aliases. Disposable Chrome
  verified Board project/board switching, creation, selection, zoom, asset
  placement, save/reload, empty and mobile gates, plus the injected database-
  outage retry path. Admin verification covered all tabs, responsive users and
  status cards, filters, pagination, dialogs, status rendering, and rolled-back
  local-only user-limit, global-limit, and pricing edits; the 390px table
  containers changed from clipped to horizontally reachable. Lint, 778 unit
  tests, 12 fresh-PostgreSQL integration tests, the production build, and diff
  checks passed. No migration, provider task, billed probe, credential change,
  or production-data mutation ran. `SEC-05` remains `in_progress`, and these
  local IDs remain outside the fixed 80-finding register.

- 2026-09-02: resolved `UI-LOCAL-03` and `UI-LOCAL-04` only after PR #28
  passed strict `web`, `database`, and Vercel preview checks and exact merge
  `95a9ca5` reached a Ready production deployment. A disposable authenticated
  Chrome session reproduced and verified the mode-switch dropdown reset and
  mobile header hit-target separation at 390px and 320px. The broader local
  smoke covered projects, server-backed search, favourites, image/video
  viewers, material insertion, and both generation modes. Lint, 776 unit tests,
  12 fresh-PostgreSQL integration tests, and the production build passed. No
  migration, provider call, billed probe, or production-data mutation ran;
  these local IDs remain outside the fixed 80-finding register.

- 2026-09-02: resolved `UI-LOCAL-01` and `UI-LOCAL-02` only after PR #26 passed
  strict `web`, `database`, and Vercel preview checks and its exact merge reached
  a Ready production deployment. Disposable Chrome and Safari automation
  covered all eight cancel-only confirmation categories and real native-video
  fullscreen navigation, exit, viewer teardown, and post-close input. Aggregate
  fixture counts stayed unchanged; no provider task or billed probe ran. These
  local IDs remain outside the fixed 80-finding register, whose totals are
  unchanged.

- 2026-09-01: merged diagnostic PR #24 after strict `web`, `database`, and
  Vercel checks passed; its production deployment is Ready. The authenticated
  runtime audit passed `ARCH-03`, `QUAL-03`, `ARCH-04`, `REL-02`, and `REL-03`,
  confirmed direct PostgreSQL for `MIG-04`, isolated `VER-08` to the already-
  withheld `kling-v2-1[2k:i2i]` case, and left `VER-10` inconclusive. No provider
  task was created and all diagnostic cleanup gates reported zero residue. A
  fresh complete 24-hour log query found 100 successful reconciliation events,
  zero poll errors, and zero video-status 5xx responses; `REL-07` remains
  monitoring because no real transient row occurred. Disposable Chrome smoke
  testing passed all eight confirmation categories and responsive viewer
  navigation/close, but native fullscreen could not be activated and Safari
  rejected WebDriver until Allow remote automation is enabled. A read-only
  `VER-07` retry reached the production DB prerequisite but stopped on expired
  local GCP ADC before listing; no thumbnail or storage write ran. The register
  remains 54 resolved and 26 pending.

- 2026-08-31: completed the post-deployment 24-hour reliability observation
  gate using four six-hour log segments to stay below Vercel's result cap. All
  96 scheduled `video_reconciliation` events were present with `ok=true`, zero
  reconciliation errors, zero poll errors, and zero stale candidates checked;
  the same exact window contained zero `/api/generate/video/status` 5xx
  responses. A read-only production aggregate found three terminal task-backed
  video outcomes persisted during the window, exactly two poll-health columns,
  one valid reconciliation index, and zero audit fixture residue. `REL-07`
  remains monitoring because no real transient poll-error row occurred; no
  provider task or billed probe was created to manufacture one. The register
  remains 54 resolved and 26 pending.

- 2026-08-29: completed the safe production portion of the reliability rollout.
  The Railway additive migration ran twice and verified exactly two poll-health
  columns plus one valid concurrent partial index. Merged PR #20 as `7d42485`;
  its production Vercel deployment is Ready. The expanded authenticated runtime
  audit passed `REL-02`, `REL-03`, and `ARCH-04`, reported no provider task
  creation, and a separate aggregate check found zero temporary users,
  generations, limits, or marked fixtures. `VER-08` remains open at 7/8 and
  `VER-10` remains inconclusive. The first authenticated reconciliation cron
  returned aggregate-only `ok=true` telemetry with zero stale candidates and
  zero errors. `REL-07` remains monitoring because production has no real
  transient poll-error row yet and the 24-hour log gate is incomplete. The
  80-finding register is 54 resolved and 26 pending.

- 2026-08-29: published reliability commit `88a43bc` as blocked draft PR #20
  after zero-warning lint, 766 unit tests, a production build, two idempotent
  video poll-health migration runs, and 12 fresh-PostgreSQL integration tests.
  No production configuration, migration, provider probe, merge, or deployment
  occurred. Published stacked audit-blocker commit `c78e77e` as draft PR #21;
  it separates Kling request safety, task-list stability, wire routing,
  resolution, and seed signals while keeping the runtime response sanitized.
  Zero-warning lint, 773 unit tests, a production build, and 12 disposable-
  PostgreSQL integration tests pass. Both draft PRs passed their GitHub `web`,
  `database`, and Vercel preview checks. The register remains 51 resolved and
  29 pending.

- 2026-08-29: ran the authenticated production runtime audit once. `ARCH-03`
  and `QUAL-03` passed their real-route checks with zero fixture residue and are
  resolved. `MIG-04` failed the active Cloud SQL backend flag, `ARCH-04` and
  `VER-08` failed their combined routing/matrix or no-task invariant, and
  `VER-10` was inconclusive. No no-task or no-charge claim is made for the Kling
  diagnostic; the production rollout stopped before migration or deployment.
  The code was later published only as blocked draft PR #20. The 80-finding
  register is 51 resolved and 29 pending.

- 2026-08-29: prepared the reliability closure batch for `REL-02`, `REL-03`,
  and `REL-07`. Added additive poll-health columns and an online partial index,
  one compare-and-set video advancement service shared by browser and cron,
  sanitized HTTP-200 transient results with bounded client backoff, a five-row
  sequential reconciliation cron, and self-cleaning runtime diagnostics for
  the real spool and queue-deadline libraries. All three findings remain
  `monitoring` until the production migration, deployment, diagnostic, cron,
  and 24-hour observation gates are evidenced.

- 2026-08-29: completed the credential-retirement and no-bill code portion of
  the accelerated batch. Removed only the eight verified-unused Blob and
  Higgsfield dev-API variables from Vercel Production/Preview while preserving
  the supported MCP compatibility credentials (`SEC-08`); recorded the
  historical retry/readability and pricing decision (`MIG-08`); and deleted the
  measured-risk supersampling path so normal requested-resolution rendering is
  the only behavior (`QUAL-06`). No provider generation or billed probe ran.

- 2026-08-29: activated GitHub ruleset `21794494` for `main`, requiring pull
  requests, resolved review threads, and strict `web`, `database`, and `Vercel`
  checks while blocking branch deletion and non-fast-forward updates (`DX-09`).
  PR #15 is the first accelerated-batch change governed by the new rule.

- 2026-08-29: merged PR #15 as `46b3dd5`; all strict `web`, `database`, and
  `Vercel` gates passed and the environment-refresh production deployment is
  Ready. One authenticated login-attempt cleanup returned HTTP 200, deleted 12
  expired rows, and emitted the matching structured event (`REL-09`). The
  temporary secret file was removed without printing or retaining its value.

- 2026-08-29: retired the never-cut-over Django port in favor of the production
  Next.js API, resolving `MIG-01`/`02`/`03`/`07`/`09`, `DRIFT-01`–`06`,
  `VER-01`–`03`, and `DX-07`. Django-only parity guards and CI setup were
  removed; PostgreSQL integration coverage now provisions the Drizzle schema
  in a disposable CI database. The hidden Next.js Higgsfield compatibility
  path, historical pricing, production database, and historical Django tables
  were not removed. Pre-retirement PR #13 passed both web and Django suites;
  no provider generation or billed probe was run. The same main run and Ready
  Vercel deployment also close `DX-02`. Aggregate-only production evidence
  closes `COST-06` with 1,955 estimated and 6 reconciled succeeded rows;
  `QUAL-03` remains `in_progress` because production currently has zero
  flagged rows to review or export.

- 2026-08-28: completed the next safe audit batch. Provider image/video results
  now persist measured model-supported aspect ratios with non-fatal inspection
  fallback (`REL-08`); depth progress explicitly distinguishes elapsed time and
  explains the long estimation stage (`QUAL-04`); and client/server process
  coordination has deterministic disposal/reset boundaries (`ARCH-08`).
  Read-only production evidence resolved Seedance 2.5 activation (`VER-11`),
  the production tree contains no historical JSON snapshot directory
  (`MIG-10`), and both CI jobs now use the approved shallow checkout policy
  (`DX-01`). No billed probe, credential action, history rewrite, or local-file
  cleanup was performed.

- 2026-08-28: implemented the next multi-issue local batch: atomic Higgsfield
  refresh leases (`SEC-05`), explicit model/provider/capability/pricing metadata
  (`ARCH-04`), a flagged-generation admin review queue (`QUAL-03`), executable
  ffmpeg health (`VER-05`), and an actual-object direct media read probe
  (`COST-04`/`VER-06`). Swept retired TypeScript source links and made the
  historical backend audit defer live state to this tracker (`DX-06`/`DX-08`).
  Deployment-dependent items remain `in_progress`; blocked/operator-held work
  was not changed.

- 2026-08-25: tracker created; P0 findings re-verified; deployed remediation
  commits recorded; `SEC-02` closed by deleting the local production export.
  `SEC-01` is blocked because the available AWS key is invalid.
- 2026-08-25: gcloud reauthentication confirmed; Cloud Storage bucket metadata
  access and production database connectivity succeeded. `SEC-03` moved to
  `in_progress`. `COST-01` and `COST-02` remain blocked because the current
  recursive verifier did not complete within a controlled execution window.
- 2026-08-25: `SEC-03` resolved. Rotated the built-in Cloud SQL `postgres`
  password to a random unretained value, confirmed the old literal is rejected,
  verified the runtime IAM principal can read and perform a rolled-back write,
  and removed the temporary service-account impersonation grant.
- 2026-08-26: replaced the unbounded recursive media verifier with a bounded,
  paginated GCS API scan and mode-0600 resumable checkpoint. Live verification
  completed in 14 pages: 6,478 referenced, 6,400 present, 78 missing. COST-01
  and COST-02 remain blocked on valid exact-bucket AWS source access.
- 2026-08-26: implemented ARCH-03 locally with an admin-configurable per-user/per-kind
  cap and fair queue ranking that skips jobs whose owner is already at cap.
- 2026-08-26: implemented REL-02 locally by serially spooling and judging best-of-N
  candidates, with lower candidate ceilings for larger render sizes.
- 2026-08-26: implemented DX-03, DX-10, and DX-11 locally with portable unit-test
  discovery and PostgreSQL-backed GitHub Actions gates for both runtimes.
- 2026-08-27: implemented REL-03 locally with an internal abort deadline and
  provider cancellation propagation. Extended REL-07 so terminal Omni 4xx
  status responses persist a failed result instead of surfacing as retryable
  502 responses and triggering an unbounded client poll loop.
- 2026-08-27: added bounded recovery for already-stuck Omni rows, retained and
  billed only accepted video best-of candidates after partial submission, and
  added structured terminal-failure telemetry without changing HTTP responses.
  Re-audited QUAL-05 and recorded its existing implementation as resolved.
- 2026-08-27: assembled the safe production release without depth claim commit
  `4301601` or its dependent fixture `300a20c`. Added the held/operator queue;
  rollout-dependent findings stay `in_progress` until deployment evidence is
  recorded, and no blocked or operator-dependent action is authorized here.
- 2026-08-27: removed the generation-health monitor's accidental dependency on
  held depth-claim columns. The release version correlates fresh depth workers
  through the currently deployed `current_job_id`; fresh-schema PostgreSQL and
  Django tests cover that compatibility path.
- 2026-08-27: production release `8f216d9` (`dpl_HVssfHS7CB6JL8cUwUWD47w1BHU2`)
  reached Ready after PR #11 preview, web/Django CI, public-route smoke checks,
  and a 10/10 production index catalog check. The formerly stuck Omni row
  `…672f64e3` settled as a persisted moderated failure through HTTP 200; the
  DB-only dry run then found zero stale Omni rows. No held action was applied.
- 2026-08-27: prepared the next safe local batch: compact confirmed media
  actions (`UI-LOCAL-01`), fullscreen-safe viewer teardown (`UI-LOCAL-02`),
  reconciled-versus-estimated admin cost reporting (`COST-06`), authenticated
  scheduled login-attempt retention (`REL-09`), and a zero-warning ESLint/CI
  gate (`DX-02`). Deployment-dependent findings remain `in_progress` or
  `ready_for_deploy`; blocked and operator-attention work remains held.
- 2026-08-27: the additive, idempotent `generations.cost_basis` migration
  completed successfully against the configured database before application
  deployment. No legacy row was guessed or backfilled as reconciled.
