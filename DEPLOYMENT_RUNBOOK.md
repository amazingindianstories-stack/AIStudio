# Free-Form Hierarchical Library & Internal Naming: Deployment & Rollback Runbook

> **Strict Operational Notice (`AGENTS.md` Rule Adherence)**:  
> Production deploys do **not** apply Drizzle schema changes automatically. Vercel builds and deploys application code only. Schema migrations must be applied and verified against the target database **before** releasing application code. All schema modifications in this release are strictly additive and 100% backward-compatible.

---

## 1. Release Inventory

- **Target Branch**: `feat/freeform-hierarchical-library-naming`
- **Pre-Migration Backup**: Cloud SQL / Managed PostgreSQL Point-In-Time Recovery (PITR) checkpoint
- **Pre-Migration Audit Scripts**:
  - `scripts/audit-folder-migration.js` (`npm run db:audit:hierarchical-folders`)
  - `scripts/audit-generation-naming.js` (`npm run db:audit:generation-naming`)
- **Additive Migration Scripts**:
  - `scripts/migrate-hierarchical-folders.js` (`npm run db:migrate:hierarchical-folders`)
  - `scripts/migrate-generation-naming.js` (`npm run db:migrate:generation-naming`)
- **Schema Verifier**: `scripts/verify-production-schema.js` (`npm run db:verify:production-schema`)
- **Online Migration Coordinator**: `src/app/api/admin/migrate-schema/route.js`

---

## 2. Step-by-Step Deployment Procedure

### Phase 1: Database Backup & PITR Snapshot

Immediately prior to running migrations, establish a verified database restore point:
1. In Cloud SQL or the managed database console, initiate an on-demand snapshot/backup.
2. Confirm Point-In-Time Recovery (PITR) / transaction logging is active.
3. Record the exact restore timestamp / snapshot ID before proceeding.

---

### Phase 2: Pre-Flight Database Audits (Read-Only)

Run both read-only pre-flight audit scripts against the target database to check for existing anomalies, orphaned references, or legacy naming collisions:

```bash
# 1. Audit hierarchical folder tree invariants and legacy sibling names
npm run db:audit:hierarchical-folders

# 2. Audit generation naming coverage, counter alignments, and sequence invariants
npm run db:audit:generation-naming
```

**Expected Result**:
- Both scripts exit with code 0.
- Confirms zero blocking integrity anomalies.
- If sibling naming collisions or orphaned references exist, resolve them prior to proceeding.

---

### Phase 3: Apply Additive Schema Migrations (Strict Ordering)

Execute the additive migrations in the following strict order:

```bash
# Step 1: Hierarchical library structure, normalized keys, and atomic constraints
npm run db:migrate:hierarchical-folders

# Step 2: Generation naming tables, sequence counters, and self-healing triggers
npm run db:migrate:generation-naming
```

*Note on Online Alternative*: If executing via the online coordinator endpoint, send an authenticated `POST` request to `/api/admin/migrate-schema` with the administrative secret header (`x-setup-secret` or `x-migration-token`). The endpoint executes the same migration steps atomically in one transaction.

---

### Phase 4: Production Schema Verification (Deployment Blocker)

Run the authoritative production schema verifier:

```bash
npm run db:verify:production-schema
```

**Verification Gate**:
- Must output: `"production schema matches all Drizzle-owned tables and hierarchy invariants"`.
- Must exit with code 0.
- **If this verifier fails, do NOT proceed to application code deployment.**

---

### Phase 5: Non-Billed Generation Smoke Verification

Per `AGENTS.md`, `itemToValues()` in `src/lib/store-db.js` writes wide rows. Before deploying application code:
1. Enqueue one non-billed generation for each affected kind (`image`, `video`, `depth`).
2. Verify row inserts succeed with default `location_version = 1` and corresponding `generation_naming` assignment.

---

### Phase 6: Worker and Application Code Deployment

#### 6.1 Deploy Railway Media Export Worker (FIRST)
Deploy the media export worker on Railway before updating the web application.
- The new worker is fully backward-compatible with legacy `manifest_version: 1` jobs (and includes double-extension guards preventing `.png.png` anomalies).
- It natively processes `manifest_version: 2` jobs using frozen verbatim filenames.
- Deploying the worker first guarantees that when the Vercel application begins submitting version-2 manifests, the live worker will process them correctly.

#### 6.2 Deploy Vercel Web Application (SECOND)
Deploy the web application from branch `feat/freeform-hierarchical-library-naming` to Vercel.
- Because all schema changes are additive and supported by backward-compatible constraint triggers, older application instances continue reading and writing normally during rollout.
- Newly deployed application instances immediately activate hierarchical library folders, breadcrumbs, Finder cards, atomic moves, container-scoped serial naming, direct signed downloads, and frozen ZIP exports.

---

### Phase 7: Post-Deployment Smoke Verification

Perform the following smoke tests in a live browser session:
1. **Hierarchical Folder Operations**:
   - Create a global root folder (e.g. `"SmokeTest-Global"`).
   - Create a child subfolder (e.g. `"Sub-1"`).
   - Verify breadcrumb navigation (`Library > SmokeTest-Global > Sub-1`).
   - Move an item between folders atomically and verify optimistic UI update.
   - Move an item to Global Unsorted and verify it appears under the Unsorted filter.
   - Clean up smoke test folders.
2. **Direct Signed Downloads**:
   - In Library and Feed, click the Download action on an image and video generation card.
   - Verify the download URL requests signed mode (`/api/generations/<id>/download?signed=1`).
   - Verify file downloads with canonical container-scoped filename (e.g. `foldername_0001.png` or `unsorted_0001.mp4`).
   - Test DetailModal and ConversationPanel download buttons to ensure shared helper consistency.
3. **ZIP Exports**:
   - Select multiple generations across different folders and export as a ZIP archive.
   - Verify media export completes successfully via Railway worker.
   - Download the generated ZIP, extract files, and verify filenames match canonical assignments without duplicates or double extensions.

---

## 3. Data-Preserving Rollback Runbook

If application code issues arise post-deployment, execute the following data-preserving rollback:

### 3.1 Application Code Rollback (Zero Data Loss)
1. **Revert Vercel Web Application**:
   - Roll back deployment in Vercel to the previous stable production release.
   - The legacy application will continue reading and writing normally.
   - The trigger `trg_check_generation_location_naming` automatically maintains `generation_naming` when the rolled-back application executes moves or inserts, preventing any check violations.

2. **Railway Export Worker Consideration**:
   - **Do NOT roll back the Railway export worker to a pre-v2 image while `manifest_version >= 2` jobs exist or are draining.**
   - Pre-v2 worker code cannot handle version-2 manifests and will fail jobs.
   - The new worker code is strictly backward-compatible with version-1 manifests, so it is safe and recommended to keep the updated worker running even if web application code is rolled back.
   - Only roll back the worker if there is an explicit worker-internal bug, and only after confirming no version-2 export jobs are queued or running in `media_exports`.

### 3.2 Non-Destructive Schema State
- **NEVER execute destructive drop-column or drop-table SQL (`DROP COLUMN`, `DROP TABLE`, `DELETE`) on production.**
- The columns `parent_id`, `name_normalized`, `version`, `updated_at`, `location_version`, `manifest_version`, and tables `generation_naming`, `naming_counters`, and `media_exports` remain completely inert to the legacy application.
- All legacy queries, inserts, and updates continue functioning without regression.

### 3.3 Catastrophic Disaster Recovery (Emergency Fallback Only)
In the event of an unrecoverable database corruption event (unrelated to standard rollback):
1. Do not attempt ad-hoc manual SQL deletion.
2. Restore an isolated recovery database from the pre-migration PITR snapshot taken in Phase 1.
3. Verify data integrity and checksums on the restored instance.
4. Point application database connection strings to the restored instance during an authorized maintenance window.
