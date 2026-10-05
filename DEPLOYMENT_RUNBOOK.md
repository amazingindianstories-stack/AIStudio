# Free-Form Hierarchical Library & Internal Naming: Deployment & Rollback Runbook

> **Strict Operational Notice (`AGENTS.md` Rule Adherence)**:  
> Production deploys do **not** apply Drizzle schema changes automatically. Vercel builds and deploys application code only. Schema migrations must be applied and verified against the target database **before** releasing application code.
>
> **Compatibility statement**: The migration is additive and read-compatible with the previous release. Some legacy organizational mutation paths, particularly destructive folder/project operations, are not guaranteed to remain compatible after the new constraints are installed. Therefore the controlled organizational-write freeze (Section 2) is mandatory until the new application release is confirmed serving.

---

## 1. Release Inventory

- **Repair Branch**: `fix/preview-regressions-codex`; deploy the exact commit qualified on the isolated preview, never a moving branch head.
- **Pre-Migration Backup**: Cloud SQL / Managed PostgreSQL Point-In-Time Recovery (PITR) checkpoint
- **Organization Snapshot Utility**: `scripts/snapshot-organization.js` (`npm run db:snapshot:organization`)
- **Pre-Migration Audit Scripts**:
  - `scripts/audit-folder-migration.js` (`npm run db:audit:hierarchical-folders`)
  - `scripts/audit-generation-naming.js` (`npm run db:audit:generation-naming`)
- **Additive Migration Scripts**:
  - `scripts/migrate-hierarchical-folders.js` (`npm run db:migrate:hierarchical-folders`)
  - `scripts/migrate-generation-naming.js` (`npm run db:migrate:generation-naming`)
- **Schema Verifier**: `scripts/verify-production-schema.js` (`npm run db:verify:production-schema`)
- **Online Migration Coordinator**: `src/app/api/admin/migrate-schema/route.js`

---

## 2. Controlled Write-Freeze Protocol

The expanded hierarchy schema enforces bidirectional foreign key, sibling uniqueness, and trigger constraints. To prevent write skew or partial state while old and new components transition, the migration window requires a short **controlled organizational-write freeze**:

### Prohibited Operations During Freeze Window:
During the maintenance window (between Step 2 and Step 18 below), the following mutations are prohibited:
1. **Project Deletion**: Do not delete any existing projects.
2. **Folder Deletion**: Do not delete any existing folders.
3. **Folder Creation**: Do not create new folders.
4. **Folder Movement**: Do not move, reparent, or rename folders.
5. **Generation Movement**: Do not move generations between folders, projects, or Unsorted.

### Snapshot-window Generation Pause:
- Before the BEFORE snapshot, block new enqueueing and drain generation/provider/polling/export/portrait-sync writes; then suspend worker and cron writers.
- Verify enforcement covers old application instances and all write paths. A UI banner alone does not enforce the freeze. If an effective infrastructure maintenance restriction is unavailable, STOP before migration.
- Gallery GET currently reconciles data; do not call it during the strict snapshot window. Admin `GET /api/assets/portraits?inventory=1` is read-only and excludes signed URLs.
- Resume generation processing only after the strict snapshot comparison passes. Keep general-user organizational mutations restricted until production smoke checks pass; operator-only disposable smoke content is the documented exception.
- No project, folder, or generation additions are allowed between the organization snapshots. There is no additions allowlist.

### Operational Procedure:
Operators schedule a brief maintenance window (estimated < 5 minutes) during low-traffic periods. If an application maintenance banner or gateway write-lock is configured, activate it before Step 2 and deactivate it after Step 18.

---

## 3. Step-by-Step Deployment Procedure (Strict Sequence)

Execute the rollout following this exact 18-step checklist:

### Step 1: Verify Production Backup / PITR Restore Point
Confirm an immediate, valid restore point exists before touching the database:
- Create an on-demand snapshot in the Cloud SQL / managed database console.
- Confirm continuous transaction archiving / Point-In-Time Recovery (PITR) is active and note the exact timestamp.

### Step 2: Enter Controlled Organizational-Write Freeze
- Announce or activate the scheduled write freeze window.
- Prohibit project/folder creation, deletion, and relocation.

### Step 3: Run Organization BEFORE Snapshot
Capture a deterministic pre-migration snapshot of all existing projects, folders, and generation assignments:
```bash
npm run db:snapshot:organization
```
Record the counts (total projects, total folders, total generations, project unsorted, global unsorted).
Use `npm run db:snapshot:organization -- --output /secure/path/before.json` to retain machine-readable evidence. Output files are created exclusively with mode 0600. Capture a separate portrait group/asset ID and scope inventory; omit media URLs and credentials.

### Step 4: Run Hierarchical-Folder Audit
Execute the read-only preflight audit for folders:
```bash
npm run db:audit:hierarchical-folders
```

### Step 5: Require Zero Blockers on Folder Audit
- The command must exit with code 0 and output: `[SUCCESS] Preflight audit passed: Database is clean and ready for additive migration.`
- If exit code is non-zero or anomalies exist, **STOP** rollout immediately and resolve anomalies before proceeding.

### Step 6: Run Generation-Naming Audit
Execute the read-only preflight audit for generation naming:
```bash
npm run db:audit:generation-naming
```

### Step 7: Require Zero Blockers on Naming Audit
- The command must exit with code 0 and output: `Preflight audit passed with 0 blocking anomalies. Ready for migration.`
- If exit code is non-zero or anomalies exist, **STOP** rollout immediately and resolve before proceeding.

### Step 8: Run Hierarchy Additive Migration
Execute the atomic hierarchical folders schema migration:
```bash
npm run db:migrate:hierarchical-folders
```
*Note: All DDL statements and verification execute atomically in one transaction and roll back on any error.*

### Step 9: Run Naming Additive Migration
Execute the atomic generation naming schema migration:
```bash
npm run db:migrate:generation-naming
```
*Note: All tables, counters, triggers, backfills, and verification execute atomically in one transaction.*

### Step 10: Run Production Schema Verifier
Execute the authoritative production schema verifier (Deployment Blocker):
```bash
npm run db:verify:production-schema
```
- Must output: `"production schema matches all Drizzle-owned tables and hierarchy invariants"` and exit 0.
- **If this verifier fails, do NOT proceed to application code deployment.**

### Step 11: Run Organization AFTER Snapshot
Capture the post-migration organization snapshot:
```bash
npm run db:snapshot:organization
```

### Step 12: Compare Preservation Invariants
Run `npm run db:compare:organization -- /secure/path/before.json /secure/path/after.json`; require exit 0. The comparator rejects malformed snapshots, duplicate IDs, any added/lost IDs, folder project/parent changes, and the existing generation/name/media invariants. Counts alone are insufficient.
Compare the before and after snapshots. The following invariants must hold with ZERO unexpected differences:
- `projects lost = 0`
- `folders lost = 0`
- `generations lost = 0`
- `existing project IDs changed = 0`
- `existing folder IDs changed = 0`
- `existing generation IDs changed = 0`
- `unexpected projects/folders/generations added = 0`
- `folder project assignments changed = 0`
- `folder parent assignments changed = 0`
- `generation project assignments changed = 0`
- `generation folder assignments changed = 0`
- `project-Unsorted membership changed = 0`
- `global-Unsorted membership changed = 0`
- `media/storage references changed = 0`
- `legacy folders with non-null parent = 0` (all legacy folders retain `parent_id = NULL`)

### Step 13: Hard Gate — STOP If Any Organizational Assignments Changed
If any existing project, folder, or generation assignment changed unexpectedly:
- **STOP immediately.**
- Do not proceed to application or worker deployment.
- Investigate diffs against pre-migration snapshot.

### Step 14: Deploy Updated Railway Media Export Worker (FIRST)
Deploy the media export worker on Railway before updating the web application:
- Worker natively processes `manifest_version: 2` exports with frozen verbatim filenames.
- Worker remains strictly backward-compatible with legacy `manifest_version: 1` jobs.
- Deploying the worker first ensures that when the web application begins issuing version-2 manifests, the live worker will process them seamlessly.

### Step 15: Deploy Vercel Application (SECOND)
Deploy the web application from the exact qualified repair commit to Vercel:
- Schema changes are additive and read-compatible with the previous release.
- Older running instances may continue serving reads during the transition; the organizational-write freeze remains in effect because legacy mutation paths are not guaranteed compatible with the new constraints.
- Newly deployed instances activate hierarchical navigation, container-scoped serial naming, signed downloads, and frozen ZIP exports.

### Step 16: Verify Expected Vercel Release Is Serving
- Check Vercel deployment identity and confirm the exact qualified repair commit is serving.
- Probe `/api/admin/status` or health endpoint to confirm response from the newly deployed commit.

### Step 17: Run Production Smoke Tests
Perform live browser smoke verification:
1. **Hierarchical Folders**: Create a test global root folder, create a child subfolder, verify breadcrumb navigation, move a generation into the subfolder, move to Global Unsorted, and clean up test folders.
2. **Direct Signed Downloads**: Click Download on an image and video card. Verify download URL requests signed mode (`/api/generations/<id>/download?signed=1`), streams directly from cloud storage, and yields canonical container-scoped filename of the shape `<readable_prefix>--<namespace_token>_<serial>.<ext>` (e.g. `foldername--<namespace_token>_0001.png`, where `<namespace_token>` is 32 lowercase hex characters).
3. **ZIP Exports**: Select multiple generations across different folders and export as ZIP. Verify export completes via Railway worker and extracted filenames match canonical assignments without duplicates or double extensions.

### Step 18: Exit Write Freeze
Once all smoke tests pass, deactivate the maintenance window / write freeze and return to normal operations.

## Updated preview qualification (mandatory before production)

The old acceptance checks were insufficient: server-rendered component tests cannot detect browser focus/blur/layout behavior; Seedance mocks accepted missing source videos and asserted the old unverified tag syntax; portrait checks covered CRUD/auth/mock fallback rather than project visibility or remote pagination; export checks replaced the deployed transport with mocks. None of those results establishes browser/provider/worker acceptance.

1. Run `npm test`, `npm run test:db`, lint, and build on Node 22. Database tests require a disposable database and retain the true legacy-upgrade suites; `test:db:setup` is not migration coverage.
2. Run `npm run test:browser` against a local server with `E2E_DATABASE_URL` pointing at a localhost `veevee_codex_regression` database and matching `AUTH_SECRET`; use mock providers. Set `E2E_START_SERVER=1` to let Playwright start the server. This fixture suite refuses remote databases/deployments and cleans only its disposable records.
3. Verify the Vercel preview database and Railway worker both target the isolated preview environment before deploying. Never inherit an unverified shared preview database setting.
4. On the actual deployed preview, exercise tree/card/breadcrumb root and subfolder rename, every creation entry point, typing/spaces/Enter/Escape/blur, retained errors, genuine conflict recovery, and 15-level scrolling at 1024px and 1440px. Verify keyboard menu focus and focus restoration.
5. Capture read-only local/remote portrait inventories before Sync. Open restored global portraits in multiple projects, switch with a selected group, reopen, Sync, and verify gallery/lightbox image loading. Compare local IDs, remote IDs, membership, ownership, and durable references afterward. No historical records may be deleted; ambiguous remote identities require reviewed reconciliation.
6. Run the exact Seedance 2.5 Generate + motion video + character image flow once, at 4 seconds and the lowest supported resolution/draft setting. Require explicit `reference` classification and a terminal successful result. Do not repeat billable probes automatically. First-frame tasks omit the omni hint; 2.0 never receives it.
7. Download real image/video/depth samples with canonical names. Create, download, open and integrity-check a real ZIP through the deployed preview worker; verify manifest-v2 frozen names.
8. Review browser, Vercel, Railway and DB logs. Missing live evidence or unexplained errors means `PREVIEW_FAIL`; production remains untouched. Record exact commit, URLs, worker revision, provider task/result, counts/ID preservation and all test outcomes.

---

## 4. Data-Preserving Rollback Runbook

If application code issues arise post-deployment, execute the following data-preserving rollback:

### 4.1 Application Code Rollback (Zero Data Loss)
1. **Revert Vercel Web Application**:
   - Roll back deployment in Vercel to the previous stable production release as a temporary emergency measure.
   - The migration is additive and read-compatible, so read traffic is safe under the rolled-back application.
   - However, legacy organizational mutation operations (moving folders, deleting projects, reordering/migrating folders) are NOT guaranteed compatible with the new schema triggers, foreign keys, or naming invariants.
   - Organizational mutation operations must remain frozen/restricted while running the rolled-back application until compatibility is explicitly evaluated or fixed.
   - While the trigger `trg_check_generation_location_naming` automatically maintains `generation_naming` for single-generation inserts/moves, broader legacy batch mutations must not be executed without verification.

2. **Railway Export Worker Consideration**:
   - **Do NOT roll back the Railway export worker to a pre-v2 image while `manifest_version >= 2` jobs exist or are draining.**
   - Pre-v2 worker code cannot handle version-2 manifests and will fail jobs.
   - The new worker code is strictly backward-compatible with version-1 manifests, so it is safe and recommended to keep the updated worker running even if web application code is rolled back.
   - Only roll back the worker if there is an explicit worker-internal bug, and only after confirming no version-2 export jobs are queued or running in `media_exports`.

### 4.2 Non-Destructive Schema State
- **NEVER execute destructive drop-column or drop-table SQL (`DROP COLUMN`, `DROP TABLE`, `DELETE`) on production.**
- The columns `parent_id`, `name_normalized`, `version`, `updated_at`, `location_version`, `manifest_version`, and tables `generation_naming`, `naming_counters`, and `media_exports` are additive and read-compatible with the legacy schema.
- Because database constraints and triggers now enforce container-scoped integrity, do not attempt to revert database tables or drop migration artifacts. Keep the schema intact to preserve data and avoid corrupting container-scoped naming state.

### 4.3 Catastrophic Disaster Recovery (Emergency Fallback Only)
In the event of an unrecoverable database corruption event (unrelated to standard rollback):
1. Do not attempt ad-hoc manual SQL deletion.
2. Restore an isolated recovery database from the pre-migration PITR snapshot taken in Step 1.
3. Verify data integrity and checksums on the restored instance.
4. Point application database connection strings to the restored instance during an authorized maintenance window.
