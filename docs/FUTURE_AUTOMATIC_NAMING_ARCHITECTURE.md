# Future Automatic Naming Architecture: Technical Design Specification

> [!WARNING] SUPERSEDED SPECIFICATION NOTICE
> The dynamic serial numbering schemes in Section 4 (`COUNT(created_at <= ...)` and `ROW_NUMBER() OVER (...)`) and the runtime ZIP seen-set deduplication in Section 5.3 **ARE SUPERSEDED AND MUST NOT BE IMPLEMENTED**.
> Dynamic timestamp counting and export window rankings cause filename instability, collisions when items share timestamps or are moved/deleted, and non-deterministic differences depending on which records are selected for export.
> **The authoritative production architecture is documented in `docs/GENERATION_NAMING_ARCHITECTURE.md`**, utilizing:
> 1. Materialized, monotonic sequences per direct folder namespace (`folder:<uuid>`, `project_unsorted:<uuid>`, `global_unsorted`).
> 2. Zero sequence reuse on deletion and atomic allocation during initial insert and cross-namespace relocation.
> 3. Zero-reallocation on lifecycle status transitions (pending -> completed), retries, project renames, and folder subtree moves.
> 4. Export manifest freezing (`manifest_version: 2`) capturing exact resolved filenames at finalize time.

## 1. Executive Summary & Design Principles

This document specifies the background design and technical architecture for automatic naming and download derivation in Veevee V1. 

The primary objective is to allow users to download or export generations with deterministic, human-readable, and context-aware filenames derived from their free-form organizational structure (e.g., `anime_characters_character_a_0001.png` or `projects_client_a_storyboard_0012.mp4`) without compromising data integrity, physical storage stability, or query performance.

### 1.1 Core Principles

1. **Strict Decoupling of Identity and Presentation**
   - The permanent identity of every generation is an immutable UUID (`generations.id`).
   - The underlying cloud storage object path (`gs://veevee-.../<generation-id>.<ext>`) is write-once, immutable, and never renamed, moved, or deleted when organizational mutations occur.
   - Filenames are a **derived presentation and export artifact**, not physical storage keys.

2. **Zero-Overhead Reorganization**
   - Renaming a folder, moving a folder subtree, or re-parenting a generation must remain metadata-only operations taking $O(1)$ to $O(K)$ database updates (where $K$ is the subtree size).
   - No background jobs, object copy cascades, or S3/GCS multipart renames are triggered during library reorganizations.

3. **Deterministic & Resilient Derivation**
   - Filename generation is deterministic based on the generation's ancestry hierarchy at the time of export/download.
   - Cross-platform filesystem safety (Windows NTFS, macOS APFS, Linux ext4) is guaranteed through rigorous sanitization and length bounding.

4. **Multi-Scope Awareness**
   - Supports both Global Library hierarchies (`/Library/Art/Anime/...`) and Project-scoped hierarchies (`/Projects/Commercial/Q4/...`), as well as virtual locations (`Global Unsorted`, `Project Unsorted`).

---

## 2. Dynamic Filename Derivation Pipeline

### 2.1 Ancestry Resolution Algorithm

When a download request or bulk ZIP export is initiated:

1. **Query Ancestry Path**:
   - For an item assigned to folder $F$, execute a recursive CTE or utilize the cached hierarchy tree (`getFolderAncestry(folderId)`) to resolve the sequence of ancestor folder names from root to leaf:
     $$P = [F_{\text{root}}, F_{\text{child}}, \dots, F_{\text{leaf}}]$$
   - If the item belongs to a Project $P_{\text{id}}$, prepend the project's sanitized name:
     $$S_{\text{scope}} = [\text{sanitize}(P_{\text{name}})]$$
   - If the item is in the Global Library:
     $$S_{\text{scope}} = [\text{"library"}]$$
   - If the item is in a virtual Unsorted location:
     $$P = [\text{"unsorted"}]$$

2. **Token Slugification**:
   - Each folder name token is transformed via `slugifyToken(name)`:
     - Apply Unicode NFKD normalization to decompose ligatures and accented characters (e.g., `é` $\to$ `e`).
     - Transliterate common non-ASCII characters to ASCII equivalents.
     - Convert all characters to lowercase.
     - Strip all illegal characters (`[^a-z0-9_]`).
     - Collapse multiple underscores, spaces, or dashes into a single underscore (`_`).
     - Strip leading and trailing underscores.
     - If the resulting slug is empty, fallback to `"folder"`.

3. **Path Concatenation**:
   - Join the tokens with underscores:
     $$\text{BaseSlug} = \text{join}(\text{"\_"}, [S_{\text{scope}}, S_{F_1}, \dots, S_{F_n}])$$

---

## 3. Filesystem Safety & Bounded Length Constraints

### 3.1 Cross-Platform Path Constraints

Different filesystems enforce strict limits:
- **ext4 / APFS**: Maximum 255 bytes per filename component.
- **NTFS / Windows Win32 API**: Historically 260 characters (`MAX_PATH`) total path limit.
- **Windows Reserved Device Names**: Filenames must not match `CON`, `PRN`, `AUX`, `NUL`, `COM1`-`COM9`, `LPT1`-`LPT9` (case-insensitive, even with an extension).
- **Prohibited Characters**: `\ / : * ? " < > | \0` and ASCII control codes ($0-31$).
- **Hidden / Special Prefixes**: Filenames must not begin with a period (`.`) or end with a space or period.

### 3.2 Bounded Truncation with Entropy Preservation

To ensure derived names never exceed safe filesystem limits (max 200 characters for the base name, leaving 55 characters for extensions, serials, and collision markers):

```typescript
function truncateAndHash(baseSlug: string, maxLen: number = 180): string {
  if (baseSlug.length <= maxLen) {
    return baseSlug;
  }
  
  // Calculate a 6-character hash of the full path to guarantee distinctness
  const hash = crypto.createHash("sha256").update(baseSlug).digest("hex").slice(0, 6);
  const truncated = baseSlug.slice(0, maxLen - 7); // reserve space for _[hash]
  
  // Avoid ending on a dangling underscore
  const cleanTruncated = truncated.replace(/_+$/, "");
  return `${cleanTruncated}_${hash}`;
}
```

### 3.3 Deep Hierarchy Path Compaction

In deeply nested folders (e.g., 15 levels), concatenating every ancestor name would produce unwieldy filenames. A multi-tier compaction policy is applied:
- **Levels 1–3**: Full inclusion: `project_parent_child_leaf`.
- **Levels > 3**: Preserve root and immediate parent, summarize intermediates:
  `project_root_..._parent_leaf` or `project_root_[hash4]_leaf`.

---

## 4. Concurrent Serial Number Allocation

A key user requirement is deterministic serial numbering (e.g., `_0001`, `_0002`).

### 4.1 Trade-off Analysis: Materialized vs. Dynamic Serials

| Strategy | Advantages | Disadvantages | Recommendation |
| :--- | :--- | :--- | :--- |
| **A. Materialized Sequence Table** (Per-folder serial counter) | High-speed single-item downloads; fixed serial at generation time. | Moving items creates gaps or duplicates; concurrent inserts lock sequence row; moving folders scrambles order. | **Reject** for free-form dynamic libraries. |
| **B. Chronological Dynamic Window** (`ROW_NUMBER() OVER (...)`) | Always zero-gap; automatically reflects moves; no sequence table locks; zero extra DB columns. | Requires query over folder items; serial can shift when older items are added. | **Recommended for Export Archives**. |
| **C. Hybrid Virtual Sequence with Materialized Version Key** | Combines stable generation timestamps with generation UUID suffix fallback. | Requires tiny computation at presign time. | **Recommended for Direct Downloads**. |

### 4.2 Recommended Direct Download Strategy

For individual downloads (`Content-Disposition: attachment; filename="<derived_name>"`):
1. Compute the item's relative index in the folder by counting prior creations:
   ```sql
   SELECT count(*) + 1 AS serial
   FROM generations
   WHERE folder_id = $folderId AND created_at <= $itemCreatedAt;
   ```
2. Format serial as zero-padded 4-digit number: `String(serial).padStart(4, "0")`.
3. Construct filename:
   $$\text{Filename} = \text{format}(\text{"%s\_%s.%s"}, \text{truncatedSlug}, \text{paddedSerial}, \text{extension})$$
   *Example:* `client_campaign_character_render_0007.png`

---

## 5. Bulk Export & ZIP Archive Hierarchy

The Veevee media export engine (`src/lib/media-exports-db.js`, `createZipArchive`) will support two export modes:

### 5.1 Flat Structured Export Mode
All files are placed in the root of the ZIP with full hierarchical prefixes:
```text
export_archive.zip/
  ├── anime_characters_protagonist_0001.png
  ├── anime_characters_protagonist_0002.png
  ├── anime_backgrounds_cyberpunk_alley_0001.png
  └── library_unsorted_0001.mp4
```

### 5.2 Nested Directory Export Mode
Folders in the ZIP mirror the virtual library tree:
```text
export_archive.zip/
  ├── Anime/
  │   ├── Characters/
  │   │   ├── protagonist_0001.png
  │   │   └── protagonist_0002.png
  │   └── Backgrounds/
  │       └── cyberpunk_alley_0001.png
  └── Unsorted/
      └── unsorted_0001.mp4
```

### 5.3 In-Memory Collision Disambiguation
During ZIP streaming, the export worker maintains a `Set<string>` of emitted archive paths. If two generations resolve to identical sanitized names, a collision suffix is appended:
```typescript
function disambiguateEntryPath(desiredPath: string, seenPaths: Set<string>): string {
  if (!seenPaths.has(desiredPath)) {
    seenPaths.add(desiredPath);
    return desiredPath;
  }
  
  const ext = path.extname(desiredPath);
  const base = desiredPath.slice(0, desiredPath.length - ext.length);
  let counter = 1;
  
  while (seenPaths.has(`${base}_(${counter})${ext}`)) {
    counter++;
  }
  
  const finalPath = `${base}_(${counter})${ext}`;
  seenPaths.add(finalPath);
  return finalPath;
}
```

---

## 6. Migration and Schema Compatibility

### 6.1 Database Schema Readiness
The schema deployed in Phase 2 & 6 (`folders` and `generations`) completely satisfies the prerequisites for this future architecture:
- `folders.parentId`: Enables $O(\log N)$ ancestor resolution via recursive SQL or client-side cached trees.
- `folders.nameNormalized`: Sibling collisions are already prevented at the database level.
- `generations.locationVersion`: Guarantees optimistic concurrency during move/export operations.

### 6.2 Future Additive Additions (Phase 12+)
When implementing automatic naming, the following additive changes may optionally be introduced:
- `user_preferences.export_naming_pattern`: Text template (e.g., `{project}_{folder}_{date}_{serial}`).
- `user_preferences.export_archive_mode`: `'flat'` or `'nested'`.

None of these require altering the core relational model established in the hierarchical library system.

---

## 7. Security and Integrity Auditing

1. **Path Traversal Protection**:
   - All slug tokens are strictly regex-filtered against `[^a-z0-9_]`.
   - Path separators (`/`, `\`, `..`) are completely stripped before constructing `Content-Disposition` or ZIP local headers.
2. **Denial of Service Prevention**:
   - Truncation boundaries prevent memory exhaustion or ZIP header overflow from abnormally long folder names.
3. **No Database Write Contention**:
   - Derivation is read-only. Generation downloads do not require acquiring row locks on `generations` or `folders`.
