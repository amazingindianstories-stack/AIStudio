# UX cutover preview — September 7, 2026

**Release preparation completed; production is not ready to launch.** The user chose
the full Django/Vite cutover after September 10's storage observation gate. No production
migration, service activation, traffic flip, or scheduler change was performed.

## Release identity

| Component | Verified identity / result |
| --- | --- |
| Application candidate | `a836d12470e4039142f852c7706da8a04b64ed54` on `migration/restore-django-cutover` |
| Pull request | [#36 — Django/Vite cutover with UX fixes](https://github.com/amazingindianstories-stack/AIStudio/pull/36); open, not merged |
| CI | [Run 34088342580](https://github.com/amazingindianstories-stack/AIStudio/actions/runs/34088342580): django, web, database all passed |
| Vercel preview | `dpl_3nxnvKzEhU5PZUuimA6GJoEsVb1G`; [immutable deployment](https://aistudio-v1-q80oa5ine-amazing-indian-stories.vercel.app) |
| Stable preview | [aistudio-cutover-preview.vercel.app](https://aistudio-cutover-preview.vercel.app); assigned to the candidate, Vercel sign-in protected |
| Railway project/environment | `balanced-acceptance` / `cutover-preview` |
| API | `218d209d-5c15-456f-a525-d405a17a7ae9`, SUCCESS; [preview health](https://veevee-api-preview-cutover-preview.up.railway.app/api/health) |
| Login cleanup | `dff78121-825e-45bf-9eb2-69c6f8f79f79`, SUCCESS; explicit run deleted 0 expired attempts |
| Video reconciliation | `800a8ac2-945a-4a46-996b-c1f4173d3bb4`, SUCCESS; explicit run checked 0 jobs, 0 polls/errors |
| Preview schedules | Both null/paused; IaC apply changed only the two preview cron schedules |
| Production retained | `dpl_FNsZRUGATFD8hjUaqdTBsvPfPb5A`, still Ready at `www.veevee.ai`; Next.js deployment unchanged |

Railway uploads used a clean `git archive` of the candidate's backend, excluding local
environment files, virtual environments, and uncommitted material. The later evidence
and paused-schedule commit does not change the application code in these deployments.
The two unrelated local planning documents were not committed.

## Release fixes and local checks

The release includes all 18 [UX audit implementations](VeeVee_Three_Persona_UX_Fixes_2026-09-07.md).
It also incorporates production's Seedance 2.5 1080p fix in both the frontend picker
and Django model capabilities.

A deployment blocker was corrected: schema adoption previously recorded every local
migration and startup audited the newest model before applying pending DDL. Adoption
now records only historical boundaries, through generation `0007`; startup audits the
applied migration state before and after normal migration execution. A real PostgreSQL
regression test proves adoption leaves `0008` pending, startup can apply it, the default
persists, repeat adoption is harmless, and unexpected catalog drift is rejected.

| Verification | Result |
| --- | --- |
| Frontend | 80 files, 812 tests passed |
| Django | 434 tests passed against disposable local PostgreSQL |
| Database integration | 13 tests passed after isolated schema setup/migration/index preparation |
| Lint | Zero warnings |
| Migration drift | No changes detected against an explicit loopback database |
| Build | Passed with the actual preview API origin and GCS media origin |
| Deployed HTML | Vite entrypoint, exact preview API/GCS CSP origins, no placeholder API origin or Next assets |
| Existing build warning | `video-frame` static/dynamic import prevents a separate chunk; build succeeds |

Local responsive, keyboard, draft, and explicit-save browser checks from the original
implementation are documented in the linked implementation report. They are not
represented as deployed-browser acceptance.

## Deployed preview acceptance

Authenticated HTTP checks used disposable synthetic admin and ordinary-user accounts,
a synthetic project, three completed-image metadata fixtures, and one disposable GCS
transport object. No generation request, provider probe, agent message, or depth job
was submitted. HTTP checks sent the exact stable-preview Origin; they do not prove
browser third-party-cookie behavior.

- API startup applied `generation.0008_generation_production_metadata` successfully;
  pre- and post-migration catalog checks passed. A separate read-only catalog check
  confirmed the non-null JSONB column and persistent `'{}'::jsonb` default.
- Login and authenticated reads passed for both roles. Session cookies were Secure,
  HttpOnly, SameSite=None, Path=/, and host-only. Exact-origin credentialed CORS passed;
  a hostile-origin profile write was rejected with 403.
- Ordinary-user admin access returned 403; admin overview and scoped logs returned 200.
  Authenticated pricing and settings reads returned 200.
- Oldest-first history pagination returned the three synthetic takes in order over two
  pages. Production metadata GET/PATCH, server-attributed review identity, stale-revision
  409, approved-only filtering, and scoped count retrieval passed.
- Board and image-agent list reads left no board or conversation record behind.
- The deployed presign endpoint issued a GCS upload URL. Upload, authenticated media
  redirect, direct signed range read (206 with matching bytes), and deletion verification
  passed. This was a transport fixture, not a playable-video or generation-quality test.
- Both sessions logged out; subsequent pricing reads returned 401.
- Synthetic users, project, takes, and activity records were removed. The uploaded
  object was verified absent. Cleanup was limited to this run's fixture IDs/keys.
- Both cron services deployed the candidate and exited successfully on an empty preview
  queue. This verifies bounded invocation, not recovery of an active provider job.

## Open gates and next action

1. **Not before September 10:** finish the storage observation and production catalog,
   capacity, queue, domains, and scheduler-ownership checks in the
   [go/no-go package](cutover-go-no-go.md). No future launch task was automatically scheduled.
2. **Deployed browser acceptance:** the available Chrome session reached Vercel sign-in,
   so deployed responsive/keyboard, cross-site browser login, drafts, and complete editing
   flows remain unverified. Protection was retained; authorized CLI access verified static
   deployment output only.
3. **Provider/depth acceptance:** name-only preview inventory found no enabled-provider
   credentials on the API or reconciliation service. Configure these and collect the
   required evidence under the appropriate provider-spend authorization. The GPU depth
   heartbeat/three-model/fencing/recovery gate remains open.
4. **Remaining preview flows:** complete the untouched broad cutover scenarios, including
   password/session renewal, full project/assets/board editing, queue settlement,
   representative media playback/thumbnails, and least-privilege IAM verification.
5. **Production readiness:** Railway production currently contains PostgreSQL only.
   Create/configure the production API and cron services in the gated launch sequence;
   verify credentials without logging values. Keep preview IaC restricted to preview.
6. Once every gate passes, capture a recoverable backup, adopt the historical schema if
   needed, execute normal migrations including `0008`, deploy/verify Django, then activate
   Vite and transfer cron ownership. Retain the Next deployment and additive metadata
   column for seven days of rollback/monitoring.

Preview availability is not a production go decision. The concrete release is pushed,
CI-verified, and available for the remaining acceptance work.
