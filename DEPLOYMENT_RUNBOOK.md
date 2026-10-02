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
  npm run db:migrate:hierarchical-folders
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

As specified in `AGENTS.md`, `itemToValues()` in `src/lib/store-db.js` writes wide rows. To prove that `generations.location_version` does not break generation insertion paths:
1. Trigger one non-billed enqueue (e.g. test image or dry-run evaluation) for affected generation kinds (`image`, `video`, `depth`).
2. Verify row inserts with default `location_version = 1`.

---

### Phase 5: Application Code Deployment

Deploy the application code from branch `feat/freeform-hierarchical-library` to production hosting (e.g., Vercel / Cloud Run).

Because all schema changes were additive and nullable/defaulted:
- Old application instances running concurrently during deployment can continue reading/writing without error.
- New application instances immediately leverage hierarchical folders, breadcrumbs, Finder cards, and atomic moves.

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

## 3. Rollback Runbook

If application code issues arise post-deployment:

### Immediate Application Rollback
1. Redeploy the previous stable application commit / release in Vercel or your hosting provider.
2. The database schema **does not need to be rolled back**.
   - The added columns (`parent_id`, `name_normalized`, `version`, `updated_at` on `folders`, and `location_version` on `generations`) are nullable or defaulted.
   - The loosened constraint (`folders.project_id` being nullable) does not break previous application code because old application code only queried project-scoped folders (`WHERE project_id = ?`).
   - Legacy application versions will function completely normally against the expanded schema.

### Optional Schema Rollback (Only if explicitly required by DBA)
If database administrators require full reversal of the schema expansion:

```sql
-- 1. Remove added indexes
DROP INDEX IF EXISTS folders_subfolder_unique_idx;
DROP INDEX IF EXISTS folders_project_root_unique_idx;
DROP INDEX IF EXISTS folders_global_root_unique_idx;
DROP INDEX IF EXISTS folders_parent_id_idx;

-- 2. Clean up any global folders created during deployment before restoring NOT NULL
DELETE FROM generations WHERE folder_id IN (SELECT id FROM folders WHERE project_id IS NULL);
DELETE FROM folders WHERE project_id IS NULL;

-- 3. Restore original columns and constraints
ALTER TABLE folders DROP CONSTRAINT IF EXISTS folders_parent_id_fkey;
ALTER TABLE folders DROP COLUMN IF EXISTS parent_id;
ALTER TABLE folders DROP COLUMN IF EXISTS name_normalized;
ALTER TABLE folders DROP COLUMN IF EXISTS version;
ALTER TABLE folders DROP COLUMN IF EXISTS updated_at;
ALTER TABLE folders ALTER COLUMN project_id SET NOT NULL;

ALTER TABLE generations DROP COLUMN IF EXISTS location_version;

-- 4. Re-create legacy unique index
CREATE UNIQUE INDEX IF NOT EXISTS folders_project_name_idx ON folders (project_id, name);
```
