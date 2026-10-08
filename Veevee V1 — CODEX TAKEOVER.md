# Veevee V1 — CODEX TAKEOVER
## Preview Regression Repair, Portrait Recovery, Seedance 2.5 Task Classification, Requalification, and Production Deployment

You are taking over this project from another coding agent.

Do NOT trust previous completion reports merely because tests passed.

The currently deployed preview was reported as `PREVIEW_PASS`, but real user testing has discovered multiple regressions that the previous acceptance suite failed to detect.

Your job is to take ownership from this point forward:

1. independently review the current implementation;
2. reproduce every reported preview defect;
3. identify related defects the previous agent missed;
4. repair the defects together without undoing the hierarchical-library and naming architecture;
5. comprehensively requalify the preview using REAL user interaction paths;
6. deploy a corrected preview;
7. if and only if every release gate passes, proceed with the controlled production rollout;
8. verify production after deployment.

Do not hand the task back to the previous agent.

Do not assume its reports are correct.

Do not redesign working architecture unnecessarily.

Correct the implementation, strengthen the tests that failed to catch these defects, and carry the release through deployment.

======================================================================
0. CURRENT BASELINE
======================================================================

Current feature line:

    feat/freeform-hierarchical-library-naming

The previous preview was based on approximately:

    68c4e30fcee8ea88b1664aa7729151756a96d4d8

The latest supplied repository ZIP may contain additional release/archive
cleanup beyond that commit.

Before changing anything, run:

    git status
    git branch --show-current
    git rev-parse HEAD
    git log --oneline -10

Read:

    AGENTS.md
    DEPLOYMENT_RUNBOOK.md
    FREEFORM_HIERARCHICAL_LIBRARY_PLAN.md
    GENERATION_NAMING_ARCHITECTURE.md
    package.json

and inspect the actual implementation.

Do not reset or discard valid existing work.

Create a dedicated Codex repair branch from the currently intended preview
baseline:

    fix/preview-regressions-codex

If the branch already exists, inspect it rather than overwriting it.

Do not force-push or rewrite history.

======================================================================
1. USER-REPORTED PREVIEW DEFECTS — ALL ARE RELEASE BLOCKERS
======================================================================

The user has manually reproduced these defects in preview:

A. Folder Rename

- Rename actions do not work reliably.
- Test ALL rename entry points:
  - folder tree context menu;
  - Finder-style child-folder cards;
  - breadcrumb/current-folder menu.

B. New Subfolder

- At least one New Subfolder action does nothing.
- Test ALL creation entry points:
  - global-root new folder;
  - project-root new folder;
  - folder-tree context-menu New Subfolder;
  - breadcrumb New Subfolder;
  - child-folder-list New button.

C. Breadcrumb / Folder Directory Scrolling

- Deep breadcrumb paths at the top do not horizontally scroll correctly.
- This must work on narrow desktop widths as well as normal desktop widths.

D. Portrait Gallery Regression

Previously stored portraits still exist in the BytePlus asset library/bucket,
but some are no longer visible in Veevee.

No portrait assets may be deleted or overwritten while diagnosing this.

E. Seedance 2.5 Generate + Motion Reference Misclassification

Reproduction concept:

- Video mode.
- Model: Seedance 2.5.
- Task mode explicitly selected as Generate.
- Attach a video as a motion/camera/action reference.
- Attach one or more character/reference images.
- Generate a NEW video.

Current behavior:

BytePlus interprets the task as an edit while Veevee sends generate-mode
ratio/duration parameters.

The remote task subsequently fails with a BytePlus
`InvalidParameter.TaskTypeConstraint`-style error.

This must be repaired at the task-classification/request-contract level.

======================================================================
2. FIRST: AUDIT WHY THE PREVIOUS PREVIEW TESTS MISSED THESE
======================================================================

Before fixing the defects, inspect the previous tests and acceptance flow.

The previous agent reported that browser acceptance passed even though these
defects are reproducible by the user.

Identify which tests were:

- API-only rather than actual UI interaction;
- server-render tests that never exercise browser focus;
- mock-provider tests that never validate the real Seedance request contract;
- regression checks that never opened Portrait Gallery;
- tests that verified endpoint existence rather than the actual button path.

Add this as a short engineering note.

The goal is not blame.

The goal is ensuring the new verification catches the same class of regression
in the future.

======================================================================
3. FOLDER RENAME / NEW-SUBFOLDER FOCUS BUG
======================================================================

Inspect at minimum:

    src/components/Dropdown.jsx
    src/components/FolderTree.jsx
    src/components/ChildFolderList.jsx
    src/components/BreadcrumbBar.jsx
    src/components/ProjectPanel.jsx
    src/lib/store.js
    src/app/api/folders/route.js
    src/lib/folder-engine.js

There is a strong suspected interaction bug:

`Dropdown.closeAndRestore()` closes the menu and schedules focus restoration to
the dropdown trigger.

Several menu actions then immediately render an `autoFocus` input.

Examples include:

- Rename;
- New Subfolder.

The scheduled focus restoration can steal focus back from the new input.

Because those editors also use `onBlur`, focus theft can immediately cancel or
submit the edit before the user can interact.

Reproduce this behavior rather than assuming the hypothesis is correct.

Implement a robust solution.

A suitable design would allow dropdown actions that intentionally transfer
focus to another control to close WITHOUT restoring focus to the original
trigger, while preserving normal accessibility behavior for ordinary menu
dismissal.

For example conceptually:

    close({ restoreFocus: false })

for actions opening:

- inline rename;
- new-folder editor;
- modal that manages its own focus.

Do not globally remove accessible focus restoration from Dropdown.

Also audit duplicate rename submission.

Several rename editors currently support both:

    form onSubmit
    input onBlur

Ensure pressing Enter cannot produce a second rename request through blur.

Use one guarded/single-flight commit path.

Do not issue two independently idempotent mutations for one user rename.

Where practical, centralize the repeated inline-folder-rename behavior rather
than maintaining three divergent copies.

======================================================================
4. TEST EVERY FOLDER CREATION / RENAME ENTRY POINT
======================================================================

After repair, manually and automatically verify:

GLOBAL

- create global root folder;
- rename global root folder;
- create global subfolder;
- rename global subfolder.

PROJECT

- create project root folder;
- rename project root folder;
- create project subfolder;
- rename project subfolder.

ENTRY POINTS

- sidebar root + button;
- tree context menu;
- breadcrumb toolbar;
- child-folder cards.

For each:

- input receives focus;
- typing works;
- Enter commits once;
- Escape cancels;
- clicking away has deliberate documented behavior;
- server error stays visible;
- version conflict reconciles correctly;
- resulting tree/breadcrumb/card updates.

Do not consider API-level success sufficient.

======================================================================
5. BREADCRUMB SCROLLING
======================================================================

Inspect:

    src/components/BreadcrumbBar.jsx

The breadcrumb nav currently uses horizontal overflow but is not necessarily
the properly constrained flexible region beside the fixed action toolbar.

Repair layout so:

- breadcrumb trail occupies remaining available width;
- action toolbar remains visible;
- breadcrumb region has `min-width: 0`;
- breadcrumb region is the actual horizontal scroller;
- deep paths can scroll fully left/right;
- current folder can be brought into view when navigation changes;
- long names do not expand the outer panel;
- trackpad horizontal scrolling works;
- shift+wheel / mouse-wheel behavior is reasonable where supported;
- keyboard focus can reveal an offscreen breadcrumb.

Test with at least 15 nested folders and a narrow desktop viewport.

Do not solve this by hiding ancestor breadcrumbs.

======================================================================
6. PORTRAIT GALLERY — PRESERVE AND RECOVER ALL EXISTING DATA
======================================================================

Treat this as a data-preservation investigation.

Inspect at minimum:

    src/components/PortraitGallery.jsx
    src/components/PortraitLightbox.jsx
    src/lib/portrait-db.js
    src/lib/portrait-sync.js
    src/lib/byteplus-assets.js
    src/lib/store.js
    src/lib/schema.js
    src/app/api/assets/portraits/route.js
    src/app/api/assets/portraits/upload/route.js
    src/app/api/assets/portraits/[id]/assets/route.js
    src/app/api/queue/execute/route.js

Do NOT delete anything from BytePlus while diagnosing.

Do NOT recreate remote assets unnecessarily.

Do NOT automatically assign legacy global portraits to arbitrary projects.

----------------------------------------------------------------------
6.1 INVESTIGATE THE CURRENT PROJECT-SCOPING REGRESSION
----------------------------------------------------------------------

The current code has a likely backward-compatibility issue:

`PortraitGallery` calls:

    loadAll(activeProjectId)

The API passes that project ID into portrait synchronization.

`listPortraitGroups(projectId)` and `listAllPortraitAssets(projectId)` currently
filter to groups whose `project_id` exactly equals that project.

Legacy portrait groups whose:

    project_id IS NULL

can therefore disappear whenever a project is active.

Remote BytePlus groups synchronized into the local DB may also be created with:

    project_id = NULL

and then immediately excluded from the response for the active project.

Confirm this against the preview database.

Produce counts:

    portrait groups by project_id
    portrait assets by group/project scope
    NULL/global portrait groups
    groups with BytePlus IDs
    assets with BytePlus IDs

Do not print signed URLs or credentials.

----------------------------------------------------------------------
6.2 BACKWARD-COMPATIBLE PORTRAIT VISIBILITY
----------------------------------------------------------------------

Preserve existing behavior for legacy assets.

Define and implement explicit semantics:

- `project_id = NULL` portrait groups are GLOBAL / LEGACY shared portraits.
- They must remain available from project contexts unless the product already
  has a stronger pre-existing rule contradicting this.
- project-specific groups remain scoped to their project.
- switching projects must not make all global legacy portraits disappear.

Do not mutate legacy global group ownership just to make them visible.

Prefer query semantics such as:

    selected project groups + global groups

rather than destructive backfills.

If there is a UI distinction between global and project portraits that can be
added without redesigning the gallery, make it clear but lightweight.

----------------------------------------------------------------------
6.3 STALE SELECTED GROUP STATE
----------------------------------------------------------------------

Audit `selectedGroupId`.

If the user:

- selects a character group;
- closes the gallery;
- changes projects;
- reopens the gallery;

the old selectedGroupId must not filter the newly loaded asset collection down
to zero.

When scope changes, reset or validate the selected group against the newly
available group set.

Add a regression test.

----------------------------------------------------------------------
6.4 BYTEPLUS PAGINATION
----------------------------------------------------------------------

The current sync calls BytePlus approximately with:

    maxResults: 100

and does not exhaust `NextToken`.

This can silently hide older assets once the remote library exceeds one page.

Implement robust pagination for:

    listAssetGroups
    listAssets

until `NextToken` is empty.

Requirements:

- deduplicate by BytePlus ID;
- deterministic ordering;
- bounded maximum page count as a safety guard;
- detect repeated NextToken loops;
- tests with at least 3 pages and >100 assets.

Do not assume the current BytePlus account contains fewer than 100 assets.

----------------------------------------------------------------------
6.5 DEDUPLICATION MUST BE SCOPE-SAFE
----------------------------------------------------------------------

The current portrait sync deduplicates groups using a lowercased group name
across the complete portrait-group list.

That is unsafe now that portrait groups can be project-scoped.

Two different projects may legitimately contain:

    Character A

or:

    General Portraits

Do NOT merge groups merely because their names match across project scopes.

Use stable remote identity (`byteplus_group_id`) as the primary reconciliation
identity.

Any name-based reconciliation must be scoped appropriately and must never
delete a valid group belonging to a different project/global scope.

Add regression tests:

    global "General Portraits"
    Project A "General Portraits"
    Project B "General Portraits"

All three must survive synchronization.

----------------------------------------------------------------------
6.6 DURABLE IMAGE REFERENCES
----------------------------------------------------------------------

Audit whether synchronization overwrites a durable Veevee storage reference
with a transient BytePlus/TOS signed URL.

If a portrait already has a durable locally controlled storage reference,
preserve it as canonical persistence.

A fresh BytePlus URL may be used for display for a remote-only asset, but an
expiring provider URL must not unnecessarily replace a durable permanent
storage key.

For BytePlus-only legacy assets:

- refresh their current remote URL safely during sync;
- keep BytePlus asset ID as stable remote identity.

Do not copy thousands of assets merely to work around URL expiry unless there
is a demonstrated requirement.

----------------------------------------------------------------------
6.7 PORTRAIT SYNC MUST NOT LOSE DATA
----------------------------------------------------------------------

Before and after the fix, compare:

- local portrait group count;
- local portrait asset count;
- unique byteplus_group_id count;
- unique byteplus_asset_id count;
- project/null scope distribution.

If access to the preview BytePlus library is available, perform a READ-ONLY
remote inventory and compare remote IDs with local IDs.

Report:

    remote assets missing locally
    local assets missing remotely
    global legacy rows hidden by project filter
    pagination-only missing assets

Do not delete remote assets during this reconciliation.

======================================================================
7. SEEDANCE 2.5 TASK-TYPE BUG — USE THE CURRENT OFFICIAL API
======================================================================

Do not fix this by guessing prompt text.

Read the CURRENT official BytePlus Seedance 2.5 documentation before changing
the provider request.

Seedance 2.5 now supports the request-level field:

    omni_reference_task_type

Supported values include:

    auto
    reference
    edit
    extend

The Veevee UI modes map conceptually as:

    Generate + ordinary multimodal references -> reference
    Edit -> edit
    Extend -> extend

The previous code relies primarily on provider inference from prompt intent and
reference-video presence and does NOT send `omni_reference_task_type`.

That leaves Generate + motion-reference requests vulnerable to being
classified as an Edit task, after which the provider rejects the ordinary
Generate ratio/duration parameters.

Fix this correctly.

----------------------------------------------------------------------
7.1 REQUIRED PROVIDER MAPPING
----------------------------------------------------------------------

For Seedance 2.5:

TEXT-ONLY GENERATE

If there are no ordinary reference assets and this is text-to-video:

- omit the omni reference hint unless official docs recommend otherwise.

REFERENCE GENERATE

If taskMode is Generate and the request includes ordinary:

- reference_image;
- reference_video;
- reference_audio;

set:

    omni_reference_task_type = "reference"

This is especially important for:

    reference video used only for motion/camera/action guidance
    +
    character/reference images

Preserve the user's ordinary Generate:

    ratio
    duration

when the official `reference` task permits them.

EDIT

Set:

    omni_reference_task_type = "edit"

Continue enforcing:

    ratio = "adaptive"
    duration = -1

and require at least one reference video.

EXTEND

Set:

    omni_reference_task_type = "extend"

Continue enforcing the documented adaptive-ratio behavior and supported
duration semantics.

FIRST FRAME / LAST FRAME

Do not accidentally classify first-frame or first/last-frame generation as an
omni reference task solely because other references are present.

Follow the official task-type contract.

SEEDANCE 2.0

Do not send the new Seedance-2.5-only field to Seedance 2.0.

----------------------------------------------------------------------
7.2 PROMPT INTENT
----------------------------------------------------------------------

BytePlus can still reject an explicit task-type hint if prompt intent clearly
contradicts it.

Do not silently rewrite the user's actual artistic prompt.

However:

- preserve/reference the correct @video / @image mapping syntax supported by
  the current provider API;
- review the existing conversion of `@vidN` into `[video N]`, because the
  current source itself says that behavior was not probe-verified;
- verify current official syntax before changing it.

Add explicit request-body tests.

----------------------------------------------------------------------
7.3 SEEDANCE TEST MATRIX
----------------------------------------------------------------------

Add provider/request tests for:

1. Seedance 2.5 text-only Generate.
2. Generate + character image.
3. Generate + one video motion reference.
4. Generate + video motion reference + multiple character images.
5. Generate + reference audio.
6. Edit + source video.
7. Edit + source video + character image.
8. Extend + source video.
9. First-frame generation.
10. First + last frame generation.
11. Seedance 2.0 reference generation.

Assert:

- `omni_reference_task_type`;
- ratio;
- duration;
- reference roles;
- model ID;
- prompt/tag conversion;
- no unsupported field leaks to 2.0.

For the user's exact reproduction:

    Seedance 2.5
    videoTaskMode = generate
    one reference video
    character images
    ordinary aspect ratio
    ordinary duration

the provider request MUST explicitly be a reference-generation task, not auto,
edit, or extend.

----------------------------------------------------------------------
7.4 LIVE PROVIDER QUALIFICATION
----------------------------------------------------------------------

After mock/request-contract tests pass, perform ONE minimal controlled preview
probe of the user's exact scenario if valid preview BytePlus credentials are
available.

Use the lowest reasonable approved cost:

- minimal supported duration;
- low/draft resolution where compatible;
- one short video motion reference;
- one character image.

Confirm the provider accepts the request and does NOT return:

    InvalidParameter.TaskTypeConstraint
    InvalidParameter.TaskTypeMismatch

Record request classification and result without logging credentials/signed
URLs.

Do not run repeated billable probes.

======================================================================
8. OTHER PREVIEW REPORT CLAIMS THAT MUST BE RE-VERIFIED
======================================================================

Because the previous report marked the build PREVIEW_PASS while these real UI
defects remained, independently rerun all important preview checks.

Do not inherit previous PASS statuses.

In particular perform actual interaction tests for:

- folder rename;
- subfolder creation;
- breadcrumb scrolling;
- Portrait Gallery;
- Seedance Generate with mixed video/image references;
- exact filename downloads;
- ZIP export through the actual preview worker.

The prior ZIP/export acceptance relied heavily on tests.

Create a REAL preview export and verify the worker processes it end-to-end.

======================================================================
9. TESTING REQUIREMENTS
======================================================================

Run all existing tests plus new regression tests.

Required:

    npm test
    npm run test:db
    npm run lint
    npm run build

Add targeted tests for:

FOLDER UI

- dropdown focus transfer;
- rename single-submit behavior;
- each New Subfolder entry point where practical;
- deep breadcrumb layout/scroll behavior.

PORTRAITS

- global legacy portraits visible while a project is active;
- project-specific portraits remain visible only where appropriate;
- switching projects clears stale selected group filter;
- BytePlus pagination;
- repeated NextToken guard;
- same-name groups in different scopes are not merged;
- existing BytePlus IDs remain stable;
- no portrait record loss during reconciliation.

SEEDANCE

- all task-mode mappings described above.

If browser automation infrastructure is absent, do not pretend unit tests prove
browser behavior.

Use the actual deployed preview and manually exercise the controls.

======================================================================
10. FIX THE ORGANIZATION SNAPSHOT COMPARATOR BEFORE PRODUCTION
======================================================================

The independent review previously identified a minor weakness in the
organization snapshot comparator.

Repair it now before production.

The comparator must fail if:

- an existing folder changes projectId;
- an unexpected new project appears;
- an unexpected new folder appears;
- an unexpected new generation appears;
- any existing generation changes project/folder assignment unexpectedly.

Its final preservation verdict must include these conditions.

Add regression tests.

======================================================================
11. SOURCE REVIEW FOR COLLATERAL REGRESSIONS
======================================================================

Before redeploying preview, review the complete diff.

Do not modify:

- permanent generation UUID semantics;
- physical media keys;
- folder naming serial allocation;
- frozen ZIP manifest behavior;
- hierarchy migration behavior;

unless a verified defect requires it.

Re-run the hierarchy and naming invariant tests after the changes.

======================================================================
12. UPDATED PREVIEW DEPLOYMENT
======================================================================

When local gates are green:

1. commit the repairs on the Codex repair branch;
2. push that branch normally;
3. deploy an UPDATED isolated preview;
4. use the existing isolated preview database or a fresh production-clone
   preview database as appropriate;
5. never point preview at the production DB.

If schema did not change, do not invent a migration.

If schema did change, document why and re-run the complete migration rehearsal.

======================================================================
13. REAL BROWSER ACCEPTANCE — REQUIRED
======================================================================

Do not call preview PASS until the following has been performed in the actual
browser.

FOLDER UX

- tree rename;
- card rename;
- breadcrumb rename;
- global root create;
- project root create;
- tree New Subfolder;
- breadcrumb New Subfolder;
- card-list New;
- Enter;
- Escape;
- blur behavior;
- deep path horizontal scroll;
- narrow viewport.

PORTRAITS

Using existing restored data:

- open gallery in Global Library;
- open gallery inside multiple projects;
- confirm legacy/global portraits appear;
- confirm project portraits appear appropriately;
- switch projects while gallery has a selected group;
- close/reopen;
- press Sync;
- verify previously missing remote assets reappear;
- confirm image previews load.

Do NOT delete historical portrait data as a test.

SEEDANCE

Test the exact user flow:

- Video;
- Seedance 2.5;
- Generate;
- attach motion-reference video;
- attach character images;
- ordinary Generate parameters;
- submit.

Confirm provider accepts the task as reference-to-video.

EXPORT

Create a real preview ZIP export and download/open it.

DOWNLOAD

Download real image/video/depth samples with exact canonical names.

======================================================================
14. PREVIEW LOG REVIEW
======================================================================

Inspect:

- Vercel preview logs;
- Railway preview worker logs;
- database errors;
- browser console/network panel.

Look specifically for:

    HTTP 500
    VERSION_CONFLICT from normal non-concurrent actions
    TaskTypeConstraint
    TaskTypeMismatch
    portrait sync errors
    BytePlus pagination errors
    duplicate portrait IDs
    FK violations
    React focus warnings
    export worker failures

PREVIEW_PASS is forbidden if unexplained errors remain.

======================================================================
15. PRODUCTION DEPLOYMENT AUTHORIZATION
======================================================================

This instruction DOES authorize production deployment, but ONLY after the new
preview passes every gate above.

If preview fails:

    STOP.
    Do NOT touch production.

If preview passes:

proceed with the controlled production rollout below.

======================================================================
16. PRODUCTION PRE-CUTOVER SAFETY
======================================================================

Before production migration/deployment:

A. Verify the exact commit intended for production.

B. Verify production database PITR/snapshot capability and take a fresh
pre-cutover restore point.

C. Enter the mandatory ORGANIZATIONAL WRITE FREEZE.

During the freeze prohibit:

- project create/delete if unsafe under mixed versions;
- folder create/delete;
- folder rename/move;
- generation location moves.

Follow the final runbook for the exact freeze scope.

D. Capture:

    npm run db:snapshot:organization

E. Also capture a READ-ONLY portrait inventory:

    portrait group count
    portrait asset count
    global/null groups
    per-project groups
    BytePlus group IDs
    BytePlus asset ID count

Do not include signed URLs/secrets.

======================================================================
17. PRODUCTION DATABASE GATES
======================================================================

Execute, in order:

    npm run db:audit:hierarchical-folders

Require exit 0.

Then:

    npm run db:audit:generation-naming

Require exit 0.

Then:

    npm run db:migrate:hierarchical-folders

Require success.

Then:

    npm run db:migrate:generation-naming

Require success.

Then:

    npm run db:verify:production-schema

Require exit 0.

Then capture:

    npm run db:snapshot:organization

Compare BEFORE and AFTER.

Required unexpected differences:

    projects lost = 0
    folders lost = 0
    generations lost = 0
    project IDs changed = 0
    folder IDs changed = 0
    generation IDs changed = 0
    folder project assignments changed = 0
    generation project assignments changed = 0
    generation folder assignments changed = 0
    project-Unsorted differences = 0
    global-Unsorted differences = 0
    media reference changes = 0
    unexpected new legacy records = 0

If ANY invariant fails:

STOP.

Do not deploy application code.

Do not automatically “repair” production.

======================================================================
18. PRODUCTION SERVICE DEPLOYMENT ORDER
======================================================================

After database gates pass:

1. Deploy the NEW Railway generation/export worker first.

Remember that `generation-worker.js` also starts the media export worker.

Confirm worker revision is healthy.

2. Deploy the corrected Vercel application second.

Use the exact tested commit.

3. Confirm the expected Vercel production deployment is serving traffic.

Do not roll the worker back while manifest-v2 jobs remain active.

======================================================================
19. PRODUCTION SMOKE TEST
======================================================================

Keep the write freeze active initially.

Verify read-only:

- projects;
- existing folders;
- generations;
- Unsorted;
- Portrait Gallery;
- legacy portrait visibility;
- generation details;
- downloads.

Then use controlled disposable test content to verify:

- create folder;
- create subfolder;
- rename folder;
- breadcrumb scroll;
- move generation;
- canonical download name.

Perform ONE controlled Seedance 2.5 Generate + motion-video + character-image
test if the preview live probe passed.

Verify it is classified as reference generation.

Verify one ZIP export.

Inspect logs.

If all checks are clean, remove the write freeze.

======================================================================
20. ROLLBACK RULES
======================================================================

Do NOT run destructive schema rollback SQL.

If Vercel application rollback is required:

- keep organizational mutations frozen;
- leave additive DB schema in place;
- use the documented compatible emergency rollback procedure.

Do NOT roll back the new Railway worker while manifest-v2 export jobs are
queued/running/retryable.

Portrait rollback must never delete or recreate the historical BytePlus
library.

======================================================================
21. FINAL REPORT
======================================================================

Return a detailed evidence report with:

CODEX TAKEOVER

    Base commit:
    Repair branch:
    Final commit:
    Diff summary:

CONFIRMED ROOT CAUSES

    Rename:
    New Subfolder:
    Breadcrumb:
    Portrait Gallery:
    Seedance 2.5:

PORTRAIT RECOVERY

    Local groups before / after:
    Local assets before / after:
    Global legacy groups:
    Remote BytePlus groups discovered:
    Remote BytePlus assets discovered:
    Pagination pages:
    Missing local IDs recovered:
    Records deleted: 0 unless individually justified

SEEDANCE

    Generate request task type:
    Edit request task type:
    Extend request task type:
    Mixed motion-video + character-image provider result:

TESTS

    Unit:
    DB:
    Lint:
    Build:
    Folder UI:
    Portrait:
    Seedance:
    Hierarchy:
    Naming:
    Downloads:
    Exports:

UPDATED PREVIEW

    URL:
    Commit:
    Real-browser folder tests:
    Portrait tests:
    Seedance test:
    ZIP export:
    Logs:

Use:

    PREVIEW_PASS

or:

    PREVIEW_FAIL

PRODUCTION

If preview passed and production deployment proceeded:

    Backup/PITR:
    Pre-migration snapshot:
    Audits:
    Migrations:
    Schema verifier:
    Post-migration preservation:
    Railway revision:
    Vercel deployment:
    Smoke tests:
    Write freeze released:

Final state must be exactly one of:

    PRODUCTION_DEPLOYED_VERIFIED

    PRODUCTION_DEPLOYED_WITH_BLOCKER

    PRODUCTION_NOT_DEPLOYED

Do not claim success without actual browser/provider/deployment evidence.