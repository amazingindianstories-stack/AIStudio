# Merged cutover preview — September 8, 2026

Production decision: **NO-GO**. The merged preview is deployed; production traffic,
production schema and all scheduler ownership remain unchanged.

## Release identity

- Production base: `7539967` (project-scoped audio transcription history).
- Rebased branch: `migration/restore-django-cutover`; PR [#36](https://github.com/amazingindianstories-stack/AIStudio/pull/36) remains open.
- Django application: `4c983208f4ab0eed59c558eab31a05c73f496c80`.
- Frontend plus audio drag/drop hotfix: `3c6ae35e2912b65ad9cec54ae778c566b181a111`. Backend files are identical to `4c98320`.
- Railway API deployment: `c201181c-26be-4672-a123-a39044a45b14`, SUCCESS, isolated `cutover-preview` environment.
- Vercel deployment: `dpl_Hkd6ZKMkaKaD8hb5KtoRzhGQ5AkT`, Ready. [Immutable preview](https://aistudio-v1-d02877p0f-amazing-indian-stories.vercel.app).
- [Stable preview](https://aistudio-cutover-preview.vercel.app) points to that hotfix deployment. Vercel protection remains enabled.
- [CI run 34216214562](https://github.com/amazingindianstories-stack/AIStudio/actions/runs/34216214562): web, django and database passed.

## Changes

Preserved production Seedream original-reference uploads, independent pricing,
provider/agent routing, Seedance 2.5 1080p and tagged audio handling. Ported Gemini
2.5 Flash transcription and project-filtered audio history into Django, including
`reference_audios` serialization/persistence and transcription metadata. Queue updates
preserve existing human review metadata. Audio references now survive composer mode
drafts; Seedream clones retain stored originals.

The transcription panel accepts drag/drop anywhere in the dialog, displays a hover
cue, validates one common audio file up to 15 MB, handles missing browser MIME types
using known extensions, and retains click-to-browse. It does not upload or start a
paid transcription until the user presses Transcribe. Invalid drops retain the prior
valid selection. Focus is trapped in the dialog; Escape restores the opening control.

Transcription reads only the authenticated user's audio-upload namespace and rejects
arbitrary URLs/protected keys before storage access. No real provider requests were
made during these checks; successful transcript persistence is covered with mocks.

## Schema verification

Disposable PostgreSQL: localhost port 55439, database `veevee_cutover`, cluster
`/private/tmp/veevee-cutover-pg`. No production database credentials were used.

The current Drizzle schema, cost-basis defaults and history indexes were created in
this database. `schema_preflight` passed, adoption recorded 22 catalog-verified
migrations, normal migrate completed, and `showmigrations` showed generation 0001–0009
applied. Model drift check reported no changes. All 13 Node database integration tests
passed.

The adoption contract audits known existing additive columns (`production_metadata`,
then `reference_audios`) against their migration state before adoption. Absent columns
remain pending real DDL. Unexpected columns still fail without recording adoption.
Regression tests cover the old preview catalog and the current production-shaped
catalog. This does **not** replace the September 10 production read-only preflight.

Railway startup independently passed preflight, applied generation 0009 as real DDL,
then passed preflight again. A separate preview catalog check and `showmigrations`
confirmed adoption through 0009. Health returned `{"status":"ok","db":true}`.

## Verification

| Gate | Result |
|---|---|
| Django | 451 tests passed, PostgreSQL |
| Frontend | 827 tests passed, 82 files |
| Node DB integration | 13 passed |
| ESLint | Zero warnings |
| Production Vite build | Passed with exact preview API/GCS origins |
| Migration drift / whitespace | No changes / clean |
| Deployed HTML | Vite entrypoint; exact preview API/GCS CSP; no Next entrypoint |
| Preview HTTP auth | Login and authenticated me/projects/audio history/settings/pricing passed |
| Preview HTTP logout | User became null and protected pricing returned 401 |
| Audio upload signing | Valid audio presign succeeded; no bytes uploaded |
| Transcription input boundary | Untrusted URL rejected with 400, no provider call |
| Local browser | Authenticated UI, audio dialog, 390×844 mobile layout, forward/backward focus wrap, Escape focus restoration passed |
| Deployed browser | **FAILED:** AIS Chrome passed Vercel protection, but app login returned to `/login` |

HTTP auth success does not prove cross-site browser cookie acceptance. The Chrome
login loop is consistent with cookie delivery restrictions, but its root cause is
not confirmed. Do not weaken browser protection or sign off authentication based on
HTTP-only results. No authenticated deployed product-flow acceptance is claimed.
Drag/drop behavior was exercised by component tests; native file dragging in the
remote preview remains unverified.

The existing video-frame static/dynamic-import build warning remains non-blocking.
The single preview test account and its activity/login-attempt records were removed;
no object was uploaded, no paid probe was submitted, and no queue/depth job was created.

## Remaining launch gates

- Resolve and verify deployed browser login/session renewal/logout, then complete the
  full responsive/product workflow acceptance in the go/no-go record.
- Provider acceptance (including live transcription/audio) and all GPU depth sizes,
  interrupted-claim fencing, stale recovery and residue checks remain unverified.
- Existing preview cron deployments remain paused; they were not redeployed or invoked
  by this run. Production service/secrets/scheduler ownership gates remain open.
- September 10 storage observation, production catalog/capacity/queue/domain checks
  and named operator signatures remain required. No monitoring window has begun.

Current production Next deployment verified read-only at `www.veevee.ai`:
`dpl_Frooezh2buT8nnJZSoHAU3oogVNj` (Ready, September 8). Retain this newer deployment
for rollback so that production audio features are preserved. The earlier retained
`dpl_FNsZRUGATFD8hjUaqdTBsvPfPb5A` also still exists, but predates those features.
