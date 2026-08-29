# Lumina Studio remediation tracker

Canonical source: `Lumina-Studio-Issues-and-Remediation-Plan.pdf` (18 August 2026).
This tracker deliberately keeps the PDF's 80 stable IDs. Update the relevant
row in the same commit as every remediation change; never record credentials,
secret values, or sensitive object names here.

States: `open`, `in_progress`, `blocked`, `monitoring`, `resolved`, `deferred`.

## Active P0 queue

| ID | State | Owner | Last verified | Evidence | Next action / exit gate |
|---|---|---|---|---|---|
| SEC-01 | blocked | AWS administrator + Codex | 2026-08-25 | AWS credentials still exist in Vercel Production and Preview, but the locally available key returns `InvalidClientTokenId`; no usable AWS-admin session is available. | Sign in with an AWS administrator, create a dedicated exact-bucket credential, update and validate both Vercel environments, then deactivate and delete the exposed key. |
| SEC-02 | resolved | Codex | 2026-08-25 | `.env.production` was deleted without reading or printing its values. | Future `vercel env pull` output is restricted to a mode-0600 file under `/tmp` and removed immediately. |
| SEC-03 | resolved | Codex | 2026-08-25 | The built-in `postgres` password was replaced with a 48-byte random unretained value; the exposed literal is rejected, the runtime IAM principal passed read and rolled-back write checks, and the temporary impersonation grant was removed. | Keep administrative access on IAM or perform another controlled password reset; never store the built-in password in application configuration. |
| COST-01 | blocked | AWS administrator + Codex | 2026-08-26 | The new bounded verifier completed in 14 resumable pages: 6,478 DB-referenced objects checked, 6,400 present, and 78 missing. The available AWS key is invalid, so the gaps cannot yet be copied from S3. | Obtain a valid exact-bucket AWS credential, migrate the 78 gaps, verify zero, observe seven stable days, perform a restore drill, then disable fallback and decommission the exact S3 bucket. |

## Held / operator-attention queue

These items are deliberately outside the 2026-08-27 safe release. Their state
in the full register remains authoritative; this view only makes the holds easy
to resume after the deployable work is stable.

| ID | Why held | Resume gate |
|---|---|---|
| SEC-01, COST-01, COST-02 | Valid exact-bucket AWS administrator access is unavailable. | Sign in with the correct AWS administrator and rotate/migrate with bounded verification. |
| MIG-06 | Depends on zero media gaps and the observation window. | Complete COST-01/COST-02 and the restore drill first. |
| REL-01, VER-04 | Requires one coordinated Vercel, Django, and GPU-worker protocol rollout. | Schedule the worker update and deliberate-kill/all-encoder exercise together. |
| COST-05 | The remaining exit test intentionally creates billed provider work. | Approve a controlled partial-submission fixture after this release stabilizes. |
| REL-07 | Applying reconciliation would mutate the reported stuck production row. | Review the DB-only dry run, then separately approve `--apply`. |
| ARCH-03 | The exit smoke test needs two authenticated user sessions. | Run the two-user fairness check after deployment. |
| ARCH-05 | Alert creation changes Vercel project configuration. | Configure the stable event-marker alert after log shape is observed. |

## Local product bugs outside the PDF register

These IDs track user-reported product defects without changing the PDF's fixed
80-ID register. `ready_for_deploy` means locally implemented and verified, not
production-confirmed.

| ID | Bug | State | Last verified | Evidence / next action |
|---|---|---|---|---|
| UI-LOCAL-01 | Media-card actions overlap and execute without confirmation | ready_for_deploy | 2026-08-27 | Failed cards now expose one contextual action plus an overflow menu; retry, regenerate, clone/edit, continue, and all delete paths use a shared accessible confirmation dialog. Unit tests and lint pass. Exit: preview smoke-test compact cards and each confirmation path. |
| UI-LOCAL-02 | Asset viewer can leave all mouse/keyboard input wedged after arrow navigation and Escape/close | ready_for_deploy | 2026-08-27 | Viewer teardown now waits for standard or Safari fullscreen exit plus two paint frames, blocks duplicate close/navigation during teardown, and refuses to unmount media if fullscreen exit fails. Fullscreen regression tests pass. Exit: reproduce the original arrow/Escape sequence in preview on Chrome and Safari. |

## Full issue register

Rows not individually re-audited since the source review remain `open`; this is
intentional and prevents an old implementation claim from being mistaken for
current verification.

| ID | Title | Sev | State | Last verified | Owner | Evidence / next action |
|---|---|---|---|---|---|---|
| MERGE-01 | Finished style-drift work was unmerged | P1 | resolved | 2026-08-25 | Codex | Merged in `2b6446b` and deployed before the Seedance limit release. |
| SEC-01 | Exposed AWS access key is unrotated | P0 | blocked | 2026-08-25 | AWS administrator + Codex | See active P0 queue. |
| SEC-02 | Plaintext `.env.production` secret dump | P0 | resolved | 2026-08-25 | Codex | Local export deleted; temporary-file-only policy recorded above. |
| SEC-03 | Cloud SQL superuser password committed by setup script | P0 | resolved | 2026-08-25 | Codex | Random unretained password set; old literal rejected; IAM read/write access verified; temporary grant removed. |
| SEC-04 | Route auth relies on every handler checking the session | P1 | resolved | 2026-08-25 | Codex | Route-auth guard shipped in `6fa858a`. |
| SEC-05 | Higgsfield refresh has no distributed lock | P1 | in_progress | 2026-08-28 | Codex | Local refresh coordination uses an atomic, expiring PostgreSQL lease plus in-process promise deduplication; losing instances adopt the centrally stored fresh token and stale owners cannot release a successor's lease. PostgreSQL concurrency/expiry/owner-safety test added. Exit: deploy and observe one controlled concurrent refresh without duplicate rotation. |
| SEC-06 | Canvas upload ignored board ID | P2 | resolved | 2026-08-25 | Codex | Board validation shipped in `2929509`. |
| SEC-07 | No Content-Security-Policy | P2 | open | 2026-08-18 | Unassigned | Schedule after final CDN domain is known. |
| SEC-08 | Dead Vercel credentials remain | P2 | resolved | 2026-08-29 | Operator + Codex | Removed only the eight verified-unused Blob and Higgsfield dev-API variable names from Vercel Production/Preview; a post-change name-only inventory confirms they are absent while the separate Production MCP compatibility credentials remain. |
| COST-01 | Duplicate S3 history remains billed | P0 | blocked | 2026-08-26 | AWS administrator + Codex | See active P0 queue. |
| COST-02 | DB-referenced objects are missing from GCS | P1 | blocked | 2026-08-26 | AWS administrator + Codex | Bounded live verification completed: 78 of 6,478 referenced objects are missing from GCS; copying is blocked by the invalid AWS source credential. |
| COST-03 | No CDN in front of GCS | P1 | open | 2026-08-18 | Unassigned | Provision CDN before removing the S3 fallback. |
| COST-04 | Media delivery can silently proxy bytes | P1 | in_progress | 2026-08-28 | Codex | Admin Status now selects recent succeeded stored media, obtains the actual browser delivery URL, performs a one-byte range read, and reports proxy fallback/read failure without exposing object identity. Exit: deploy and record an `ok` direct-read result. |
| COST-05 | Video best-of-N can bill after partial failure | P2 | in_progress | 2026-08-27 | Codex | Local settlement logic retains every provider-accepted task ID, continues with a partial candidate set, emits accepted/rejected counts, and reduces estimated cost to accepted candidates. Exit: deploy and verify a controlled partial-submission fixture. |
| COST-06 | Provider costs mix exact and estimated values | P2 | resolved | 2026-08-29 | Codex | Aggregate-only production verification found 1,955 succeeded estimated rows and 6 succeeded reconciled rows after deployment, proving both classes are persisted. Admin totals, user summaries, logs, and CSV exports expose the split. |
| COST-07 | Pricing rows contain unverified placeholders | P2 | open | 2026-08-18 | Unassigned | Reconcile one invoice month. |
| REL-01 | Dead depth worker strands a running job | P1 | in_progress | 2026-08-27 | Codex | Claim-fenced implementation `4301601` remains isolated on `fix/audit-p0` and is intentionally held out of this release until the Vercel/Django/GPU worker rollout and VER-04 kill exercise can be coordinated. The unsafe `fb7046b` implementation was not reused. |
| REL-02 | Best-of-N holds all full-resolution candidates in memory | P1 | monitoring | 2026-08-27 | Codex | Serial spooling/judging and size-bounded candidate caps deployed in production `8f216d9`; main CI and local suites pass. Monitor production memory and latency before closing. |
| REL-03 | Queue execution lacks an internal pre-timeout abort | P2 | monitoring | 2026-08-27 | Codex | The 270-second internal abort deadline and provider cancellation propagation deployed in production `8f216d9`; main CI passes. Monitor a real timeout to confirm terminal persistence precedes Vercel termination. |
| REL-04 | Stale reaper threshold can drift below route timeout | P2 | resolved | 2026-08-25 | Codex | Literal comparison guard shipped in `6fa858a`. |
| REL-05 | Client scope and SQL scope can drift | P2 | resolved | 2026-08-27 | Codex | PostgreSQL scope/order/keyset parity passed on PR #11 and main CI run `33055388366` after the production migration chain. |
| REL-06 | `db:push` does not create indexes | P2 | resolved | 2026-08-27 | Codex | Production read-only catalog verification reports all 10 expected indexes present; the registry, optimizer, Admin Status check, and live-catalog CI test shipped in `8f216d9`. |
| REL-07 | Repeated poll errors can leave a row running forever | P2 | monitoring | 2026-08-27 | Codex | Production `8f216d9` converted stuck Omni row `…672f64e3` to terminal moderated failure through HTTP 200, emitted a persisted structured event, and the DB-only reconciler now finds zero stale Omni rows. No `--apply` action was used; monitor the Vercel 5xx anomaly before closing. |
| REL-08 | Most providers trust requested aspect ratio | P3 | resolved | 2026-08-28 | Codex | Image outputs (Gemini/Nano Banana, Higgsfield, Kling) and video outputs (Higgsfield, Omni, BytePlus, including best-of winners) are measured from the same bytes used for persistence. The nearest model-supported ratio is stored; structured mismatch/inspection warnings and requested-ratio fallback keep metadata failures non-fatal. Synthetic image and local ffmpeg video fixtures pass. |
| REL-09 | Login-attempt cleanup is opportunistic | P3 | in_progress | 2026-08-27 | Codex | Local authenticated daily cron globally deletes expired login-attempt rows using the shared retention cutoff; middleware exemption remains protected by timing-safe bearer auth. Unit and PostgreSQL integration tests pass. Exit: set `CRON_SECRET`, deploy, and observe one successful bounded run. |
| MIG-01 | Django port is not cut over | P1 | resolved | 2026-08-29 | Codex | The never-cut-over Django port was retired in favor of the production Next.js API; its complete tracked source remains recoverable in Git history. |
| MIG-02 | Live routes are missing from Django | P1 | resolved | 2026-08-29 | Codex | Eliminated with the retired secondary runtime; `src/app/api/` is the sole route implementation. |
| MIG-03 | Live tables are missing Django models | P1 | resolved | 2026-08-29 | Codex | Eliminated with the retired secondary runtime. Drizzle remains schema authority; no production table was dropped. |
| MIG-04 | Cloud SQL is staged but not live | P2 | open | 2026-08-18 | Unassigned | Rotate superuser password before any cutover. |
| MIG-05 | Cloud CDN is not provisioned | P1 | open | 2026-08-18 | Unassigned | Choose hostname and execute the CDN runbook. |
| MIG-06 | Rollback credentials were never removed | P1 | blocked | 2026-08-25 | Operator + Codex | Blocked by zero-gap media verification and observation window. |
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
| VER-04 | Depth worker lacks end-to-end production/GPU verification | P1 | open | 2026-08-18 | Unassigned | Run all encoders and a deliberate worker kill with REL-01. |
| VER-05 | Bundled ffmpeg is unverified on Vercel | P2 | in_progress | 2026-08-28 | Codex | Admin Status executes the bundled binary with `-version`; the local runtime check and registry test pass. Exit: deploy and record the target-runtime status result. |
| VER-06 | GCS signing under WIF is unconfirmed | P1 | in_progress | 2026-08-28 | Codex | The media-delivery health check now proves an actual recent object is directly readable rather than only proving that a synthetic URL can be signed; identifiers and URLs are redacted. Exit: record an `ok` result under Vercel WIF. |
| VER-07 | Thumbnail warm-up was never run | P2 | open | 2026-08-18 | Unassigned | Dry-run then apply with recorded counts. |
| VER-08 | Kling 2K reference rule lacks controlled probe | P2 | open | 2026-08-18 | Unassigned | Run the free validation probe. |
| VER-09 | Seedance continuation relies on third-party evidence | P2 | open | 2026-08-18 | Unassigned | Run the bounded billed probe. |
| VER-10 | Kling seed support is unconfirmed | P3 | open | 2026-08-18 | Unassigned | Run the free seed probe. |
| VER-11 | Seedance 2.5 activation is unconfirmed | P2 | resolved | 2026-08-28 | Codex | Read-only production generation evidence contains 11 Seedance 2.5 rows: 9 succeeded and 2 failed. Successful provider completions prove the production account/model is activated, so the picker entry remains offered; no billed probe was run. |
| VER-12 | Audio surcharge pricing lacks invoice verification | P3 | open | 2026-08-18 | Unassigned | Reconcile an invoice. |
| ARCH-01 | API responses use multiple envelopes | P2 | open | 2026-08-18 | Unassigned | Address only with migration decision. |
| ARCH-02 | Storage module contains dual provider branches | P2 | deferred | 2026-08-25 | Unassigned | Delete the S3 branch after COST-01 rather than abstracting it. |
| ARCH-03 | Concurrency cap is global, not per user | P1 | in_progress | 2026-08-26 | Codex | Local `83b80d6` adds `maxConcurrentJobs` and fair eligible-job ranking; PostgreSQL fairness/override/tie tests pass. Exit: deploy and smoke-test with two users. |
| ARCH-04 | Capabilities and prices key on display-name regexes | P2 | in_progress | 2026-08-28 | Codex | Local explicit model registry owns provider wire IDs, picker visibility, pricing keys, and capability gates; provider routing and token/image/audio pricing no longer infer behavior from display-name regexes. Focused registry/config/provider/pricing tests pass. Exit: full gates, deploy, and smoke each free validation path. |
| ARCH-05 | Generation failures return HTTP 200 | P2 | monitoring | 2026-08-27 | Codex | Production observed the versioned privacy-bounded `generation_failure` event for `video_status`/`omni_provider_status` with `persisted:true` while preserving HTTP 200. Alert configuration remains in the operator-attention queue. |
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
| QUAL-03 | Flagged-generation signal has no consumer | P3 | in_progress | 2026-08-28 | Codex | Admin generation logs now support a server-side `flagged=1` review queue, show reason/judge evidence, and include flag metadata in RFC 4180 CSV; the existing bounded fixture exporter remains available. Exit: deploy and review/export representative flagged rows. |
| QUAL-04 | Depth progress uses coarse milestones | P3 | resolved | 2026-08-28 | Codex | Retained worker percentage, milestone count, and live timer; the card now labels the timer as elapsed (not remaining) and explains that depth estimation is normally the longest stage. No fabricated ETA was added because the vendored inference API exposes no per-frame callback. |
| QUAL-05 | Canvas asset project does not own board context | P2 | resolved | 2026-08-27 | Codex | Re-audit found the fix already present in `0b2c02b`: Canvas has an explicit board-project selector, clears the old board before switching, fences stale list responses, and labels the independent control `Assets from:`. A source guard now pins those invariants. |
| QUAL-06 | Supersampling has measured scene-accuracy risk | P3 | resolved | 2026-08-29 | Codex | Deleted the unused supersampling branch, downsampling helper, environment documentation, pricing override, and related comments. Gemini now always renders and persists the requested resolution; a source guard prevents the risky flag from returning. |

## Change log

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
