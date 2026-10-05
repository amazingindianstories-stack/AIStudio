# Veevee V1 Generation Naming & Export Architecture

## 1. Overview & System Goals

This document specifies the internal naming system for Veevee V1 built on top of the free-form hierarchical library. The system provides stable, human-readable, folder-scoped filenames for direct individual generation downloads and asynchronous bulk ZIP exports.

### 1.1 Core Tenets
1. **Decoupling Identity from Presentation**:
   - Physical storage objects are immutable and addressed by UUID (`gs://<bucket>/generated/<uuid>.<ext>`). Physical storage objects are never renamed or relocated when library folders or projects change.
   - User-facing download and export filenames are deterministically resolved presentation artifacts reflecting current library ancestry and stable sequences.
2. **Materialized Folder-Scoped Serials**:
   - Monotonically increasing sequences allocated per direct container namespace (`folder:<uuid>`, `project_unsorted:<uuid>`, `global_unsorted`).
   - Serials are immutable across generation lifecycle transitions (`pending` -> `running` -> `completed`), retries, project renames, and folder subtree relocations.
   - Relocating a generation across direct container namespaces atomically reallocates a fresh sequence in the destination namespace.
   - Deleting a generation leaves a gap; deleted serials are never recycled or reused.
3. **Pure Server-Side Resolution**:
   - Filenames are resolved uniformly on the server across direct downloads, web UI inspection, and ZIP export preparation.
   - Strict cross-platform filesystem sanitization (APFS, NTFS, ext4), 255-byte bounded length with SHA-256 entropy preservation, and Windows device name collision avoidance.
4. **Frozen Export Manifests**:
   - Asynchronous ZIP exports freeze generation filenames at manifest finalization (`manifest_version: 2`).
   - The export worker streams frozen filenames verbatim without re-derivation, ensuring exported archives remain bit-for-bit immutable regardless of subsequent library reorganizations.

---

## 2. Database Schema & Relational Integrity

### 2.1 Table Definitions (`src/lib/schema.js`)

#### `naming_counters`
Tracks the next sequence to assign in each container namespace.
```sql
CREATE TABLE naming_counters (
  namespace TEXT PRIMARY KEY,
  next_sequence BIGINT NOT NULL DEFAULT 1,
  updated_at BIGINT NOT NULL,
  CONSTRAINT naming_counters_next_sequence_check CHECK (next_sequence >= 1)
);
```

#### `generation_naming`
Materializes the container namespace and sequence number allocated to each generation.
```sql
CREATE TABLE generation_naming (
  generation_id UUID PRIMARY KEY REFERENCES generations(id) ON DELETE CASCADE,
  namespace TEXT NOT NULL,
  sequence BIGINT NOT NULL,
  assigned_at BIGINT NOT NULL,
  CONSTRAINT generation_naming_namespace_seq_idx UNIQUE (namespace, sequence),
  CONSTRAINT generation_naming_sequence_check CHECK (sequence > 0)
);

CREATE INDEX generation_naming_namespace_idx ON generation_naming(namespace);
```

#### `media_exports` and `media_export_items`
```sql
ALTER TABLE media_exports ADD COLUMN manifest_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE media_export_items ADD COLUMN filename TEXT;
```

### 2.2 Bidirectional Scope Integrity Triggers

PostgreSQL triggers enforce that `generation_naming.namespace` always matches the actual location of the generation in `generations`:
- `trg_check_generation_naming_scope`: Evaluates on `INSERT` or `UPDATE` of `generation_naming`. Enforces that the namespace accurately reflects `generations.folder_id` and `generations.project_id`.
- `trg_check_generation_location_naming`: Evaluates on `UPDATE` of `generations.folder_id` or `generations.project_id`. Ensures that if a generation changes its direct container, the corresponding `generation_naming` row has been reallocated to match.

---

## 3. Sequence Allocation Engine (`src/lib/generation-naming.js`)

### 3.1 Namespaces
- **Folder**: `folder:<uuid>`
- **Project Unsorted**: `project_unsorted:<uuid>`
- **Global Unsorted**: `global_unsorted`

### 3.2 Atomic Allocation
Sequences are allocated inside the same database transaction as the generation creation or relocation:
```sql
INSERT INTO naming_counters (namespace, next_sequence, updated_at)
VALUES ($1, 2, $now)
ON CONFLICT (namespace)
DO UPDATE SET
  next_sequence = naming_counters.next_sequence + 1,
  updated_at = EXCLUDED.updated_at
RETURNING (next_sequence - 1) AS allocated_sequence;
```
Because PostgreSQL row locks on `naming_counters` serialize updates per namespace, concurrent generation creations within the same folder receive monotonically increasing numbers without collision.

### 3.3 Relocation Rules
- **Cross-namespace move** (e.g. from Folder A to Folder B, or Global Unsorted to Project Unsorted): Reallocates `last_sequence + 1` in the destination namespace.
- **Same-namespace move** (e.g. moving between positions in the same folder): Preserves sequence number and namespace.
- **Folder subtree move** (e.g. moving Folder A into Folder B): Subtree folder generations keep their `folder:<id>` namespace and serials. Only the hierarchical path prefix updates dynamically.
- **Lifecycle transitions & retries**: `upsertItem` checks for existing naming entries; status updates from pending to running/completed never reallocate serials.

---

## 4. Pure Filename Resolver (`src/lib/filename-resolver.js`)

### 4.1 Filename presentation (updated by user request)

Only the folder ancestry and stable container serial appear in download names.
Project names and internal UUID/namespace tokens are omitted. For example,
`R01` containing `Sc001` produces `R01_SC001_0001.png` (or `.mp4`). Reel and
scene codes are uppercased; other folder tokens retain portable lowercase ASCII
slugification. Unsorted assets use `unsorted_0001.<ext>`.

The serial remains allocated by the existing naming counters. Sorting, lifecycle
updates, retries, and project renames do not renumber assets. Moving an asset to
another folder allocates its next destination serial; moving a whole folder
preserves serials and changes only the readable ancestry.

### 4.2 Collisions and frozen archives

Compact filenames are scoped to their folders, not globally unique across
projects. Identical folder paths or normalized names can yield identical
filenames. ZIP finalization rejects duplicate case-normalized filenames before
queueing rather than silently overwriting entries or adding IDs. Existing
finalized manifests retain their frozen names, including older decorated names.

### 4.3 Length bounding

Names remain bounded to 255 UTF-8 bytes. Only paths exceeding that limit receive
a deterministic 16-character SHA-256 truncation hash; normal reel/scene names
contain no hash or ID suffix. The serial and extension are never truncated.

### 4.4 Windows Device Name Guard
If the readable prefix equals a Windows reserved device name (`CON`, `PRN`, `AUX`, `NUL`, `COM1`..`COM9`, `LPT1`..`LPT9`), it is prefixed with an underscore (e.g. `_con--<namespace_token>_0001.png`).

### 4.5 Batch Recursive CTE Resolution
Single recursive query resolves all ancestors in one database round-trip:
```sql
WITH RECURSIVE folder_ancestry AS (
  SELECT f.id AS leaf_id, f.id, f.name, f.parent_id, f.project_id, 0 AS depth
  FROM folders f
  WHERE f.id = ANY($folderIds)
  UNION ALL
  SELECT fa.leaf_id, p.id, p.name, p.parent_id, p.project_id, fa.depth + 1
  FROM folders p
  INNER JOIN folder_ancestry fa ON fa.parent_id = p.id
)
```

---

## 5. Direct Download Route (`/api/generations/[id]/download`)

### 5.1 Route Semantics
- **Methods**: `GET` and `HEAD`.
- **Authentication**: Requires valid authenticated user session (via `getSession()` or verified session cookie). Unauthenticated requests return `401 UNAUTHENTICATED`.
- **Validation**:
  - Missing generation: `404 GENERATION_NOT_FOUND`.
  - Non-completed status (`pending`, `running`): `409 GENERATION_PROCESSING`.
  - Failed status (`failed`): `409 GENERATION_FAILED`.
  - Missing media or protected key: `404 MEDIA_NOT_FOUND`.
- **Response Headers**:
  - `Content-Disposition`: RFC 6266 compliant: `attachment; filename="<ascii>"; filename*=UTF-8''<encoded>`.
  - `Content-Type`: Set from stored object MIME type.
  - `X-Content-Type-Options: nosniff`.
  - `Cache-Control: private, no-cache, no-store, must-revalidate`.
  - `Accept-Ranges: bytes`.
  - `Content-Range`: Set on Range requests (`206 Partial Content`).
- **Streaming**: Upstream media object stream is piped directly into the response without whole-file memory buffering. Client disconnects immediately abort the upstream stream.

---

## 6. Bulk Export & Asynchronous ZIP Worker

### 6.1 Manifest Freezing (`src/lib/media-exports-db.js`)
When an export job is finalized:
1. `batchResolveGenerationFilenames` resolves the exact filenames for all items queued in the export.
2. The resolved filenames are saved into `media_export_items.filename`.
3. `media_exports.manifest_version` is set to `2`, and the job status transitions to `queued`.

### 6.2 Verbatim Streaming (`src/worker/media-export-worker.js`)
When `manifest_version >= 2`, the export worker reads `item.filename` directly from the database row and passes it verbatim to `writeZip64`. Subsequent library reorganizations, folder renames, or item relocations do not affect the finalized archive.

#### 6.2.1 Worker Rollout Order & Backward Compatibility
- **Deployment Sequence**: The Railway media export worker MUST be deployed FIRST, before deploying the Vercel web application.
- **Manifest Compatibility**: The export worker supports both `manifest_version: 1` (legacy jobs) and `manifest_version: 2` (frozen naming jobs).
- **Double Extension Guard**: When processing `manifest_version: 1`, the worker checks whether `item.filename` already ends with the extension before appending it, preventing `.png.png` anomalies during transition windows.

### 6.3 Large Archive Support (`src/lib/zip64-stream.js`)
- Full Zip64 format support (extra field tag `0x0001`, 64-bit size records, Zip64 end-of-central-directory locator).
- Supports archives with >65,535 files and >4 GB payload.
- Validated with Python's `zipfile.testzip()` for cross-platform archive integrity.

---

## 7. Migration & Rollback Runbook

### 7.1 Preflight Audit
Before applying the migration in production:
```bash
npm run db:audit:generation-naming
```
Verifies that:
- Every generation has valid scope integrity.
- No dangling generation or folder references exist.

### 7.2 Migration Execution
The additive, idempotent migration is exposed as:
```bash
npm run db:migrate:generation-naming
```
It:
1. Creates `naming_counters` and `generation_naming` tables.
2. Adds `manifest_version` to `media_exports` and `filename` to `media_export_items`.
3. Attaches bidirectional scope integrity trigger functions.
4. Deterministically backfills existing generations ordered by `created_at ASC, id ASC`, ensuring historical serial stability.

### 7.3 Post-Migration Verification
```bash
npm run db:verify:production-schema
```
Verifies table existence, column nullability, check constraints, foreign keys, and trigger attachments.

### 7.4 Data-Preserving Rollback Procedure
If issues are discovered after deployment, execute a zero-data-loss rollback:
1. **Redeploy Previous Application on Vercel**:
   - Revert deployment to the previous stable release.
2. **Redeploy Previous Export Worker on Railway**:
   - Revert export worker deployment on Railway to the previous stable release.
3. **Database Schema Remains Intact and Inert**:
   - Schema additions are non-breaking and additive.
   - The trigger `trg_check_generation_location_naming` automatically maintains `generation_naming` when the rolled-back application executes moves or inserts, preventing any check violations.
   - Existing serials and namespace counters remain preserved and harmlessly inert to the rolled-back application.
   - **Never run destructive SQL (`DROP TABLE`, `DELETE FROM generations`) on production.**
4. **Emergency Disaster Recovery (Catastrophic Scenario Only)**:
   - In the event of catastrophic operational corruption, restore from a verified pre-migration Point-In-Time (PITR) backup onto an isolated database instance.

---

## 8. Verification Matrix

| Category | Description | Status | Evidence |
| :--- | :--- | :--- | :--- |
| **Category 1** | Concurrent creation in one folder (100 parallel creates, unique monotonic serials, zero reuse on deletion) | **VERIFIED** | `src/lib/generation-naming.integration.js` (Cat 1 pass) |
| **Category 2** | Mixed asset types (image, video, depth) sharing namespace; status updates & retries preserve serials | **VERIFIED** | `src/lib/generation-naming.integration.js` (Cat 2 pass) |
| **Category 3** | Simultaneous moves, idempotency replay, payload mismatch 409, same-location no-op, rollback safety | **VERIFIED** | `src/lib/generation-naming.integration.js` (Cat 3 pass) |
| **Category 4** | Out-and-back gets new serial; folder subtree move preserves serials & dynamically updates path prefix | **VERIFIED** | `src/lib/generation-naming.integration.js` (Cat 4 pass) |
| **Category 5** | Global Unsorted, Project Unsorted, nested folders, cross-scope moves | **VERIFIED** | `src/lib/generation-naming.integration.js` (Cat 5 pass) |
| **Category 6** | Folder renames update filename; project renames do not affect filename or serial | **VERIFIED** | `src/lib/generation-naming.integration.js` (Cat 6 pass) |
| **Category 7** | ZIP manifest freeze at finalize; later moves do not alter archive; Python `zipfile.testzip()` on 257+ entries | **VERIFIED** | `src/lib/generation-naming.integration.js` (Cat 7 pass) |
| **Category 8** | Direct download route streaming, Range/HEAD headers, 401/403/404/409 error handling | **VERIFIED** | `src/lib/generation-naming.integration.js` (Cat 8 pass) |
| **Category 9** | Migration preflight audit, idempotent rerun, upgrade from prior release schema, invariant enforcement | **VERIFIED** | `src/lib/true-legacy-migration.integration.js` pass |
| **Category 10** | Pure resolver unit tests: slugification, Windows reserved names, compact reel/scene names, length bounding | **VERIFIED** | `src/lib/filename-resolver.test.js` (8 unit tests pass) |
