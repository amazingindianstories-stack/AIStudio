/** Canonical names for every non-primary index declared on `generations`. */
export const EXPECTED_GENERATION_INDEX_NAMES = Object.freeze([
  "generations_created_at_idx",
  "generations_queue_idx",
  "generations_project_id_idx",
  "generations_folder_id_idx",
  "generations_user_created_idx",
  "generations_created_keyset_idx",
  "generations_project_keyset_idx",
  "generations_folder_keyset_idx",
  "generations_favorite_keyset_idx",
  "generations_flagged_keyset_idx",
]);

/** Online-safe definitions used to reconcile a migrated database. */
export const GENERATION_INDEX_STATEMENTS = Object.freeze([
  `create index concurrently if not exists generations_created_at_idx
     on generations (created_at)`,
  `create index concurrently if not exists generations_queue_idx
     on generations (status, kind, created_at)`,
  `create index concurrently if not exists generations_project_id_idx
     on generations (project_id)`,
  `create index concurrently if not exists generations_folder_id_idx
     on generations (folder_id)`,
  `create index concurrently if not exists generations_user_created_idx
     on generations (user_id, created_at)`,
  `create index concurrently if not exists generations_created_keyset_idx
     on generations (created_at desc, id desc)`,
  `create index concurrently if not exists generations_project_keyset_idx
     on generations (project_id, created_at desc, id desc)`,
  `create index concurrently if not exists generations_folder_keyset_idx
     on generations (folder_id, created_at desc, id desc)`,
  `create index concurrently if not exists generations_favorite_keyset_idx
     on generations (favorited_at desc, id desc) where is_favorite`,
  `create index concurrently if not exists generations_flagged_keyset_idx
     on generations (flagged_at desc, id desc) where flagged`,
]);
