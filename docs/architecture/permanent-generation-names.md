# Permanent generation names

Django assigns a canonical media name when a new generation first lands in a folder. Creation in a folder assigns it immediately; a new generation created in Unsorted keeps a provisional `unsorted_NNNN` name until first filing. The name uses the folder ancestry at assignment and a monotonic sequence from that folder's existing counter. The actual native media extension is resolved from the master, so unfinished work does not freeze an incorrect container extension.

`generations.permanent_name` stores the assigned stem. Later folder renames, folder moves, generation moves and project changes preserve it, its allocation namespace, sequence and assignment time. A database trigger rejects replacing or clearing it. Sequence allocation remains atomic, including production runtime's private counter namespace. Deletion does not reset counters or make numbers reusable.

Individual downloads and new ZIP media leaves use the canonical name. New ZIP directories follow current organization. If canonical names collide in the same ZIP directory, generation-ID subdirectories preserve both media leaf names. Existing frozen export manifests and source media bytes remain unchanged.

## Upgrade

`generation.0003_generation_permanent_name` adds the nullable stem, freezes every existing generation at its current individual/download name (including existing Unsorted rows), and updates the deferred naming trigger. Historical rows without a naming record retain the old sequence-1 fallback name. The migration never rewrites existing export manifests or counters. It locks folder ancestry during the backfill; quiesce generation and folder writers for the controlled migration and keep them quiesced until compatible code is promoted, so old readers cannot expose mutable names during the rollout. It runs as part of a separately reviewed, controlled migration release; application startup does not migrate.

Before release, run `backend/manage.py audit_generation_names` against an approved database copy using the isolated test environment. The read-only JSON report provides the number of backfill rows, nested-folder rows whose new ZIP media leaf changes to match the existing individual download name, and existing frozen export disagreements. Production counts require a separately authorized copy and are not inferred from synthetic fixtures.

The upgrade test rehearses the previous migration state with nested folders, missing naming records, existing counters and frozen export manifests. Fresh-database tests apply the complete graph. Schema rollback removes the field and restores the old location-coupled naming function, so it does not retain permanent-name behavior; a release rollback should keep this additive migration and roll back compatible code only.

## Authorization

Only admins may delete empty folders, delete any generation kind, or move generations through either single or bulk endpoints. These checks run before mutations and idempotent replay. Folder deletion is enforced in the shared `folder_engine.delete_folder` service, covering both `DELETE /api/folders` and the legacy `POST /api/projects` `deleteFolder` operation; missing or inactive actors cannot bypass the service guard. Active or uncertain paid generation evidence remains protected from deletion. Favorites and flags remain available to authenticated users. Folder creation, rename, recolor and folder move remain available to authenticated users, including moves of a folder containing generations.

Portraits, uploads, exports, material assets and canvas board permissions are unchanged. Django owns authorization; hidden frontend controls are an additional usability boundary.
