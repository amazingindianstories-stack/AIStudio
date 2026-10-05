# Free-Form Hierarchical Library & Internal Naming: Deployment & Rollback Runbook

> **Strict Operational Notice (`AGENTS.md` Rule Adherence)**:  
> Production deploys do **not** apply Drizzle schema changes automatically. Vercel builds and deploys application code only. Schema migrations must be applied and verified against the target database **before** releasing application code. All schema modifications in this release are strictly additive and 100% backward-compatible.

---

## 1. Release Inventory

- **Target Branch**: `feat/freeform-hierarchical-library-naming`
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

### Allowed Operations:
- Read-only browsing and feed inspection remain fully available.
- Enqueueing new image/video generations continues normally (triggers auto-assign naming rows without blocking).

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
Compare the before and after snapshots. The following invariants must hold with ZERO unexpected differences:
- `projects lost = 0`
- `folders lost = 0`
- `generations lost = 0`
- `existing project IDs changed = 0`
- `existing folder IDs changed = 0`
- `existing generation IDs changed = 0`
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
Deploy the web application from branch `feat/freeform-hierarchical-library-naming` to Vercel:
- Schema changes are strictly additive and backward-compatible.
- Older running instances continue functioning normally during the transition.
- Newly deployed instances activate hierarchical navigation, container-scoped serial naming, signed downloads, and frozen ZIP exports.

### Step 16: Verify Expected Vercel Release Is Serving
- Check Vercel deployment dashboard and confirm the deployment from `feat/freeform-hierarchical-library-naming` is live.
- Probe `/api/admin/status` or health endpoint to confirm response from the newly deployed commit.

### Step 17: Run Production Smoke Tests
Perform live browser smoke verification:
1. **Hierarchical Folders**: Create a test global root folder, create a child subfolder, verify breadcrumb navigation, move a generation into the subfolder, move to Global Unsorted, and clean up test folders.
2. **Direct Signed Downloads**: Click Download on an image and video card. Verify download URL requests signed mode (`/api/generations/<id>/download?signed=1`), streams directly from cloud storage, and yields canonical container-scoped filename (e.g. `foldername_0001.png`).
3. **ZIP Exports**: Select multiple generations across different folders and export as ZIP. Verify export completes via Railway worker and extracted filenames match canonical assignments without duplicates or double extensions.

### Step 18: Exit Write Freeze
Once all smoke tests pass, deactivate the maintenance window / write freeze and return to normal operations.

---

## 4. Data-Preserving Rollback Runbook

If application code issues arise post-deployment, execute the following data-preserving rollback:

### 4.1 Application Code Rollback (Zero Data Loss)
1. **Revert Vercel Web Application**:
   - Roll back deployment in Vercel to the previous stable production release.
   - The legacy application will continue reading and writing normally.
   - The trigger `trg_check_generation_location_naming` automatically maintains `generation_naming` when the rolled-back application executes moves or inserts, preventing any check violations.

2. **Railway Export Worker Consideration**:
   - **Do NOT roll back the Railway export worker to a pre-v2 image while `manifest_version >= 2` jobs exist or are draining.**
   - Pre-v2 worker code cannot handle version-2 manifests and will fail jobs.
   - The new worker code is strictly backward-compatible with version-1 manifests, so it is safe and recommended to keep the updated worker running even if web application code is rolled back.
   - Only roll back the worker if there is an explicit worker-internal bug, and only after confirming no version-2 export jobs are queued or running in `media_exports`.

### 4.2 Non-Destructive Schema State
- **NEVER execute destructive drop-column or drop-table SQL (`DROP COLUMN`, `DROP TABLE`, `DELETE`) on production.**
- The columns `parent_id`, `name_normalized`, `version`, `updated_at`, `location_version`, `manifest_version`, and tables `generation_naming`, `naming_counters`, and `media_exports` remain completely inert to the legacy application.
- All legacy queries, inserts, and updates continue functioning without regression.

### 4.3 Catastrophic Disaster Recovery (Emergency Fallback Only)
In the event of an unrecoverable database corruption event (unrelated to standard rollback):
1. Do not attempt ad-hoc manual SQL deletion.
2. Restore an isolated recovery database from the pre-migration PITR snapshot taken in Step 1.
3. Verify data integrity and checksums on the restored instance.
4. Point application database connection strings to the restored instance during an authorized maintenance window.
