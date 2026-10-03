# Free-Form Hierarchical Library System: Deployment & Rollback Runbook

> **Strict Operational Notice (`AGENTS.md` Rule Adherence)**:  
> Production deploys do **not** apply Drizzle schema changes automatically. Vercel builds and deploys application code only. Schema migrations must be applied and verified against the target database **before** releasing application code. All schema modifications in this release are strictly additive and 100% backward-compatible.

---

## 1. Release Inventory

- **Branch**: `feat/freeform-hierarchical-library`
- **Additive Migration Script**: `scripts/migrate-hierarchical-folders.js` (Script: `npm run db:migrate:hierarchical-folders`)
- **Pre-flight Audit Script**: `scripts/audit-folder-migration.js` (Script: `npm run db:audit:hierarchical-folders`)
- **Schema Verifier**: `scripts/verify-production-schema.js` (Script: `npm run db:verify:production-schema`)
- **Online Migration Coordinator**: `src/app/api/admin/migrate-schema/route.js`

---

## 2. Step-by-Step Deployment Procedure

### Phase 1: Pre-Flight Database Audit (Read-Only)

Before altering any database objects, run the pre-flight audit against the target environment. This inspects existing `folders` and `generations` rows for legacy naming collisions, orphaned project references, or anomalies:

```bash
npm run db:audit:hierarchical-folders
```

**Expected Result**:
- Exit code 0.
- Summary indicates total folders and generations scanned.
- Confirms zero blocking integrity anomalies. If collisions are detected in legacy root folders with identical case-insensitive names within the same project, the audit reports them for administrative review prior to migration.

---

### Phase 2: Apply Additive Schema Migration (Expand Phase)

Execute the additive idempotent migration. This:
1. Alters `folders.project_id` to `DROP NOT NULL` (enabling global library folders).
2. Adds `folders.parent_id UUID REFERENCES folders(id) ON DELETE RESTRICT`.
3. Adds `folders.name_normalized TEXT NOT NULL DEFAULT ''`.
4. Adds `folders.version INTEGER NOT NULL DEFAULT 1`.
5. Adds `folders.updated_at BIGINT NOT NULL DEFAULT 0`.
6. Adds `generations.location_version INTEGER NOT NULL DEFAULT 1`.
7. Backfills `folders.name_normalized` from existing `name` (trimmed, lowercase, collapsed spaces).
8. Creates partial unique indexes:
   - `folders_global_root_unique_idx` on `(name_normalized)` where `parent_id IS NULL AND project_id IS NULL`.
   - `folders_project_root_unique_idx` on `(project_id, name_normalized)` where `parent_id IS NULL AND project_id IS NOT NULL`.
   - `folders_subfolder_unique_idx` on `(parent_id, name_normalized)` where `parent_id IS NOT NULL`.
9. Creates foreign key performance indexes: `folders_project_id_idx`, `folders_parent_id_idx`.

**Execution Options**:
- **CLI (Recommended)**:
  ```bash
  # Step 2A: Hierarchical library structure & normalized keys
  npm run db:migrate:hierarchical-folders

  # Step 2B: Generation naming tables, sequence counters & trigger functions
  npm run db:migrate:generation-naming
  ```
- **Online Admin Route (Alternative)**:
  Authenticated POST request with bearer admin session to `/api/admin/migrate-schema`.

---

### Phase 3: Production Schema Verification (Deployment Blocker)

Run the authoritative production schema verifier:

```bash
npm run db:verify:production-schema
```

**Verification Gate**:
- Must output: `"production schema matches all Drizzle-owned tables and hierarchy invariants"`.
- Must exit with code 0.
- **If this verifier fails, do NOT proceed to application code deployment.**

---

### Phase 4: Non-Billed Generation Verification

As specified in `AGENTS.md`, `itemToValues()` in `src/lib/store-db.js` writes wide rows. To prove that `generations.location_version` and naming triggers do not break generation insertion paths:
1. Trigger one non-billed enqueue (e.g. test image or dry-run evaluation) for affected generation kinds (`image`, `video`, `depth`).
2. Verify row inserts with default `location_version = 1` and corresponding `generation_naming` assignment.

---

### Phase 5: Worker and Application Code Deployment

#### 5.1 Deploy Railway Media Export Worker (FIRST)
Deploy the media export worker on Railway before updating the web application.
- The new worker is fully backward-compatible with legacy `manifest_version: 1` jobs (and includes double-extension guards preventing `.png.png` anomalies).
- It natively processes `manifest_version: 2` jobs using frozen verbatim filenames.
- Deploying the worker first guarantees that when the Vercel application starts submitting version-2 manifests, the live worker will process them correctly.

#### 5.2 Deploy Vercel Web Application (SECOND)
Deploy the web application from branch `feat/freeform-hierarchical-library-naming` to Vercel.
- Because all schema changes are additive and supported by backward-compatible constraint triggers, older application instances continue reading and writing normally during rollout.
- Newly deployed application instances immediately activate hierarchical library folders, breadcrumbs, Finder cards, atomic moves, container-scoped serial naming, direct downloads, and frozen ZIP exports.

---

### Phase 6: Post-Deployment Smoke Verification

Perform the following smoke tests in a live browser session:
1. **Navigate to Library tab**: Verify Global Library root renders with "Unsorted" and existing global content.
2. **Create Global Root Folder**: Create folder `"SmokeTest-Global"`.
3. **Create Subfolder**: Open `"SmokeTest-Global"` and create child folder `"Sub-1"`.
4. **Breadcrumb Navigation**: Verify breadcrumb bar shows `Library > SmokeTest-Global > Sub-1` and clicking ancestry navigates correctly.
5. **Move Item**: Move a generation into `"Sub-1"`, verify item moves atomically.
6. **Move Item to Global Unsorted**: Move item to `"Global Unsorted"`, verify it appears in Unsorted filter.
7. **Projects Regression**: Open an existing Project, create a project folder, move an item into it, verify project scope is preserved.
8. **Delete Empty Folders**: Clean up smoke test folders.

---

## 3. Data-Preserving Rollback Runbook

If application code issues arise post-deployment, execute the following data-preserving rollback:

### 3.1 Immediate Application & Worker Rollback (Zero Data Loss)
1. **Redeploy Previous Application Release on Vercel**:
   - Revert deployment to the previous stable production commit.
2. **Redeploy Previous Worker Release on Railway**:
   - Revert Railway export worker deployment to the previous stable production release.
3. **Database Schema Remains Intact and Inert**:
   - The expanded schema is strictly additive and backward-compatible.
   - The trigger `trg_check_generation_location_naming` automatically maintains `generation_naming` when the rolled-back application executes moves or inserts, preventing any check violations.
   - The columns `parent_id`, `name_normalized`, `version`, `updated_at`, `location_version`, `manifest_version`, and tables `generation_naming` and `naming_counters` remain inert to the old application without breaking queries.
   - **No destructive SQL (`DELETE` or `DROP TABLE`) should ever be executed on production.**

### 3.2 Emergency Disaster Recovery (Catastrophic Scenario Only)
If a catastrophic operational failure occurs that cannot be resolved via application rollback:
1. **Never execute manual `DELETE` or `DROP` statements on live production data.**
2. Provision an isolated recovery database from the pre-migration Point-In-Time (PITR) snapshot.
3. Verify data integrity and checksums on the recovery database.
4. Update application connection strings during an authorized, scheduled maintenance window.
