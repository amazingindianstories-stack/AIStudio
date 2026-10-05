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

### 4.1 Slugification & Sanitization
1. **Unicode NFKD Decomposition**: Accented and special characters are decomposed into ASCII base forms (e.g. `é` $\to$ `e`, `ö` $\to$ `o`).
2. **Token Normalization**: All characters converted to lowercase; illegal characters replaced with underscores; consecutive underscores collapsed; leading and trailing underscores trimmed. Empty tokens default to `folder`.
3. **Ancestry Path Building**:
   - Global Unsorted: `library_unsorted`
   - Project Unsorted: `<project_name>_unsorted`
   - Folders: Full ancestor chain `<project_name>_<parent>_<child>_<leaf>` or `<root_folder>_<child>_<leaf>`.
4. **Serial Formatting**: Zero-padded to at least 4 digits (`0001`, `0042`, `9999`, `10000`).

### 4.2 Canonical Filename Shape
Every resolved filename has the form:

```
<readable_prefix>--<namespace_token>_<serial>.<ext>
```

Example: `foldername--3f2a9c1e5b7d4e8fa0c1b2d3e4f5a6b7_0001.png`

- `<namespace_token>` is a fixed-width, 32-character lowercase hex token derived from the direct container: the folder UUID (folders), the project UUID (project Unsorted), or 32 zeros (Global Unsorted).
- Slugified user text only ever contains `[a-z0-9_]` with single underscores, so the `--` delimiter cannot be impersonated by any folder or project name. This makes filenames unique across namespaces regardless of how the readable prefix normalizes, and independent of which batch requested them.

### 4.3 Length Bounding & Entropy Preservation
- Maximum filename length: **255 UTF-8 bytes** (standard limit for APFS, NTFS, and ext4).
- The tail `--<namespace_token>_<serial>.<ext>` is invariant and never truncated.
- If the full name would exceed 255 bytes, only the readable prefix is truncated, and a 6-character hex SHA-256 digest of the un-truncated prefix is inserted before the token:
  `<truncated_prefix>_<hash6>--<namespace_token>_<serial>.<ext>`

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
| **Category 6** | Project and folder renames update filename dynamically without reallocating serial | **VERIFIED** | `src/lib/generation-naming.integration.js` (Cat 6 pass) |
| **Category 7** | ZIP manifest freeze at finalize; later moves do not alter archive; Python `zipfile.testzip()` on 257+ entries | **VERIFIED** | `src/lib/generation-naming.integration.js` (Cat 7 pass) |
| **Category 8** | Direct download route streaming, Range/HEAD headers, 401/403/404/409 error handling | **VERIFIED** | `src/lib/generation-naming.integration.js` (Cat 8 pass) |
| **Category 9** | Migration preflight audit, idempotent rerun, upgrade from prior release schema, invariant enforcement | **VERIFIED** | `src/lib/true-legacy-migration.integration.js` pass |
| **Category 10** | Pure resolver unit tests: slugification, Windows reserved names, collision suffix, length bounding | **VERIFIED** | `src/lib/filename-resolver.test.js` (8 unit tests pass) |
