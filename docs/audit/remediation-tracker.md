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
| SEC-05 | Higgsfield refresh has no distributed lock | P1 | open | 2026-08-18 | Unassigned | Re-audit before Higgsfield retirement decision. |
| SEC-06 | Canvas upload ignored board ID | P2 | resolved | 2026-08-25 | Codex | Board validation shipped in `2929509`. |
| SEC-07 | No Content-Security-Policy | P2 | open | 2026-08-18 | Unassigned | Schedule after final CDN domain is known. |
| SEC-08 | Dead Vercel credentials remain | P2 | open | 2026-08-25 | Operator + Codex | Vercel still lists `BLOB_*` and retired Higgsfield dev-API variables. |
| COST-01 | Duplicate S3 history remains billed | P0 | blocked | 2026-08-26 | AWS administrator + Codex | See active P0 queue. |
| COST-02 | DB-referenced objects are missing from GCS | P1 | blocked | 2026-08-26 | AWS administrator + Codex | Bounded live verification completed: 78 of 6,478 referenced objects are missing from GCS; copying is blocked by the invalid AWS source credential. |
| COST-03 | No CDN in front of GCS | P1 | open | 2026-08-18 | Unassigned | Provision CDN before removing the S3 fallback. |
| COST-04 | Media delivery can silently proxy bytes | P1 | open | 2026-08-18 | Unassigned | Verify current production mode, then add monitoring. |
| COST-05 | Video best-of-N can bill after partial failure | P2 | open | 2026-08-18 | Unassigned | Revisit before enabling video best-of-N. |
| COST-06 | Provider costs mix exact and estimated values | P2 | open | 2026-08-18 | Unassigned | Mark estimates and reconcile provider usage. |
| COST-07 | Pricing rows contain unverified placeholders | P2 | open | 2026-08-18 | Unassigned | Reconcile one invoice month. |
| REL-01 | Dead depth worker strands a running job | P1 | open | 2026-08-25 | Codex | Local commit `fb7046b` is excluded pending ownership-safe completion and kill tests. |
| REL-02 | Best-of-N holds all full-resolution candidates in memory | P1 | open | 2026-08-18 | Unassigned | Spool candidates and judge one at a time. |
| REL-03 | Queue execution lacks an internal pre-timeout abort | P2 | open | 2026-08-18 | Unassigned | Add a provider abort before the platform limit. |
| REL-04 | Stale reaper threshold can drift below route timeout | P2 | resolved | 2026-08-25 | Codex | Literal comparison guard shipped in `6fa858a`. |
| REL-05 | Client scope and SQL scope can drift | P2 | open | 2026-08-18 | Unassigned | Add property/parity tests. |
| REL-06 | `db:push` does not create indexes | P2 | open | 2026-08-18 | Unassigned | Add declared-vs-live index verification. |
| REL-07 | Repeated poll errors can leave a row running forever | P2 | open | 2026-08-18 | Unassigned | Add stuck-row monitoring without changing terminal semantics. |
| REL-08 | Most providers trust requested aspect ratio | P3 | open | 2026-08-18 | Unassigned | Measure provider outputs where practical. |
| REL-09 | Login-attempt cleanup is opportunistic | P3 | open | 2026-08-18 | Unassigned | Add scheduled retention cleanup. |
| MIG-01 | Django port is not cut over | P1 | open | 2026-08-18 | Unassigned | Re-audit against current backend before choosing ship/delete. |
| MIG-02 | Live routes are missing from Django | P1 | open | 2026-08-18 | Unassigned | Re-audit current route parity. |
| MIG-03 | Live tables are missing Django models | P1 | open | 2026-08-18 | Unassigned | Re-audit current model parity. |
| MIG-04 | Cloud SQL is staged but not live | P2 | open | 2026-08-18 | Unassigned | Rotate superuser password before any cutover. |
| MIG-05 | Cloud CDN is not provisioned | P1 | open | 2026-08-18 | Unassigned | Choose hostname and execute the CDN runbook. |
| MIG-06 | Rollback credentials were never removed | P1 | blocked | 2026-08-25 | Operator + Codex | Blocked by zero-gap media verification and observation window. |
| MIG-07 | Railway Django service does not exist | P2 | open | 2026-08-18 | Unassigned | Re-audit current deployment state. |
| MIG-08 | Higgsfield UI is gone but backend remains | P3 | open | 2026-08-18 | Unassigned | Decide retirement and preserve historical pricing. |
| MIG-09 | Unreachable legacy agent routes remain in Django | P3 | open | 2026-08-18 | Unassigned | Remove only after current route audit. |
| MIG-10 | Pre-Postgres JSON snapshots remain | P3 | open | 2026-08-18 | Unassigned | Archive after recovery requirements are confirmed. |
| DRIFT-01 | Python video directive lacks reference legends | P1 | open | 2026-08-18 | Unassigned | Re-audit JS/Python parity. |
| DRIFT-02 | Django lacks video best-of-N pipeline | P2 | open | 2026-08-18 | Unassigned | Keep feature off until parity or cutover decision. |
| DRIFT-03 | Django lacks server-side frame extraction | P2 | open | 2026-08-18 | Unassigned | Decide with video best-of-N/cutover. |
| DRIFT-04 | Python `crispen` is non-exact | P3 | open | 2026-08-18 | Unassigned | Match or explicitly disable. |
| DRIFT-05 | Django GCS authentication differs and is unverified | P2 | open | 2026-08-18 | Unassigned | Live-verify in the target runtime. |
| DRIFT-06 | Django media reads lack abort propagation | P2 | open | 2026-08-18 | Unassigned | Decide based on final media serving location. |
| DRIFT-07 | Cross-language constants were hand-synced | P1 | resolved | 2026-08-25 | Codex | Constant parity guard shipped in `6fa858a`. |
| DRIFT-08 | JS and Python ZIP outputs lacked equivalence coverage | P3 | resolved | 2026-08-25 | Codex | ZIP parity guard shipped in `6fa858a`. |
| VER-01 | Django generation providers lack live calls | P1 | open | 2026-08-18 | Unassigned | Budget and run only before a Django cutover. |
| VER-02 | Django Higgsfield MCP path is unexercised | P2 | open | 2026-08-18 | Unassigned | Resolve with Higgsfield retirement decision. |
| VER-03 | Django agent path lacks a live Gemini turn | P3 | open | 2026-08-18 | Unassigned | Verify only if Django ships. |
| VER-04 | Depth worker lacks end-to-end production/GPU verification | P1 | open | 2026-08-18 | Unassigned | Run all encoders and a deliberate worker kill with REL-01. |
| VER-05 | Bundled ffmpeg is unverified on Vercel | P2 | open | 2026-08-25 | Unassigned | Bundle exclusion shipped, but runtime verification remains. |
| VER-06 | GCS signing under WIF is unconfirmed | P1 | open | 2026-08-18 | Unassigned | Inspect production media-delivery status and signed read. |
| VER-07 | Thumbnail warm-up was never run | P2 | open | 2026-08-18 | Unassigned | Dry-run then apply with recorded counts. |
| VER-08 | Kling 2K reference rule lacks controlled probe | P2 | open | 2026-08-18 | Unassigned | Run the free validation probe. |
| VER-09 | Seedance continuation relies on third-party evidence | P2 | open | 2026-08-18 | Unassigned | Run the bounded billed probe. |
| VER-10 | Kling seed support is unconfirmed | P3 | open | 2026-08-18 | Unassigned | Run the free seed probe. |
| VER-11 | Seedance 2.5 activation is unconfirmed | P2 | open | 2026-08-18 | Unassigned | Confirm activation or hide the picker entry. |
| VER-12 | Audio surcharge pricing lacks invoice verification | P3 | open | 2026-08-18 | Unassigned | Reconcile an invoice. |
| ARCH-01 | API responses use multiple envelopes | P2 | open | 2026-08-18 | Unassigned | Address only with migration decision. |
| ARCH-02 | Storage module contains dual provider branches | P2 | deferred | 2026-08-25 | Unassigned | Delete the S3 branch after COST-01 rather than abstracting it. |
| ARCH-03 | Concurrency cap is global, not per user | P1 | open | 2026-08-18 | Unassigned | Add per-user admission control. |
| ARCH-04 | Capabilities and prices key on display-name regexes | P2 | open | 2026-08-18 | Unassigned | Add explicit provider/capability metadata. |
| ARCH-05 | Generation failures return HTTP 200 | P2 | deferred | 2026-08-25 | Unassigned | Preserve response contract; add observability instead. |
| ARCH-06 | Zustand store is oversized | P3 | deferred | 2026-08-25 | Unassigned | Split only when touched for functional work. |
| ARCH-07 | Admin dashboard component is oversized | P3 | deferred | 2026-08-25 | Unassigned | Split only when touched for functional work. |
| ARCH-08 | Mutable module state sits outside stores | P3 | open | 2026-08-18 | Unassigned | Inventory before changing semantics. |
| DX-01 | Git history is bloated by research binaries | P2 | open | 2026-08-18 | Unassigned | Choose history rewrite or shallow-clone policy. |
| DX-02 | ESLint configuration is missing | P2 | open | 2026-08-18 | Unassigned | Add flat config after P0. |
| DX-03 | No CI gate | P1 | open | 2026-08-18 | Unassigned | Add build, JS, Django, and migration checks. |
| DX-04 | Dead root `scratch.js` | P3 | resolved | 2026-08-25 | Codex | Deleted in `5c591a8`. |
| DX-05 | Setup script referenced the wrong bucket/deployment | P3 | resolved | 2026-08-25 | Codex | Deleted in `5c591a8`. |
| DX-06 | Documentation contains `.ts`/`.tsx` path drift | P3 | open | 2026-08-18 | Unassigned | Sweep after architecture stabilizes. |
| DX-07 | Django history paths in `CLAUDE.md` are stale | P3 | open | 2026-08-18 | Unassigned | Sweep after migration decision. |
| DX-08 | Backend audit body presents resolved work as open | P3 | open | 2026-08-18 | Unassigned | Add per-finding resolution markers. |
| DX-09 | Main auto-deploys with no preview gate | P2 | open | 2026-08-25 | Unassigned | Use audit branch previews now; add protected CI later. |
| DX-10 | Script-test naming convention is unenforced | P3 | open | 2026-08-18 | Unassigned | Add a repository guard. |
| DX-11 | Test discovery uses non-portable shell `find` | P3 | open | 2026-08-18 | Unassigned | Replace with a portable test manifest/discovery script. |
| QUAL-01 | Video scaffolding is reasoned, not bake-off measured | P2 | open | 2026-08-18 | Unassigned | Build fixtures before changing directives. |
| QUAL-02 | Eval harness has no fixtures or CI gate | P2 | open | 2026-08-18 | Unassigned | Commit at least ten representative fixtures. |
| QUAL-03 | Flagged-generation signal has no consumer | P3 | open | 2026-08-18 | Unassigned | Add admin review and fixture export. |
| QUAL-04 | Depth progress uses coarse milestones | P3 | open | 2026-08-18 | Unassigned | Improve only alongside real worker verification. |
| QUAL-05 | Canvas asset project does not own board context | P2 | open | 2026-08-18 | Unassigned | Make selection switch board context or relabel it. |
| QUAL-06 | Supersampling has measured scene-accuracy risk | P3 | deferred | 2026-08-25 | Unassigned | Expose an explicit tradeoff or delete the flag. |

## Change log

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
