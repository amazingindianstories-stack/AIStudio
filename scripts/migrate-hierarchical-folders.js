import { config } from "dotenv";
import { sql } from "drizzle-orm";
import { getDb } from "../src/lib/db.js";

config({ path: process.env.ENV_FILE || ".env.local" });

export const HIERARCHICAL_FOLDER_STATEMENTS = [
  // 1. Allow global folders (project_id nullable)
  "ALTER TABLE folders ALTER COLUMN project_id DROP NOT NULL",

  // 2. Add parent_id for arbitrary hierarchy (nullable self-reference with RESTRICT on delete)
  "ALTER TABLE folders ADD COLUMN IF NOT EXISTS parent_id UUID REFERENCES folders(id) ON DELETE RESTRICT",

  // 3. Add normalized name key for Unicode sibling uniqueness
  "ALTER TABLE folders ADD COLUMN IF NOT EXISTS name_normalized TEXT",

  // 4. Add optimistic concurrency versioning
  "ALTER TABLE folders ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1",

  // 5. Add modification timestamp
  "ALTER TABLE folders ADD COLUMN IF NOT EXISTS updated_at BIGINT NOT NULL DEFAULT 0",

  // 6. Add generation location versioning to prevent async workers from overwriting user moves
  "ALTER TABLE generations ADD COLUMN IF NOT EXISTS location_version INTEGER NOT NULL DEFAULT 1",

  // 7. Add foreign key constraints if not present (idempotent blocks)
  `DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'folders'::regclass AND conname = 'folders_project_id_fkey') THEN
      ALTER TABLE folders ADD CONSTRAINT folders_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT;
    END IF;
  END $$;`,

  `DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'folders'::regclass AND conname = 'folders_parent_id_fkey') THEN
      ALTER TABLE folders ADD CONSTRAINT folders_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES folders(id) ON DELETE RESTRICT;
    END IF;
  END $$;`,

  `DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'generations'::regclass AND conname = 'generations_project_id_fkey') THEN
      ALTER TABLE generations ADD CONSTRAINT generations_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT;
    END IF;
  END $$;`,

  `DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'generations'::regclass AND conname = 'generations_folder_id_fkey') THEN
      ALTER TABLE generations ADD CONSTRAINT generations_folder_id_fkey FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE RESTRICT;
    END IF;
  END $$;`,

  // 8. Backfill normalized name from display name using canonical Unicode NFKC (updating any stale keys)
  "UPDATE folders SET name_normalized = LOWER(TRIM(NORMALIZE(name, NFKC))) WHERE name_normalized IS DISTINCT FROM LOWER(TRIM(NORMALIZE(name, NFKC)))",
  "ALTER TABLE folders ALTER COLUMN name_normalized SET DEFAULT ''",
  "ALTER TABLE folders ALTER COLUMN name_normalized SET NOT NULL",

  // 9. Backfill updated_at from created_at
  "UPDATE folders SET updated_at = created_at WHERE updated_at = 0 OR updated_at IS NULL",
  "ALTER TABLE folders ALTER COLUMN updated_at SET DEFAULT 0",

  // 10. Hierarchy navigation and foreign-key indexes
  "CREATE INDEX IF NOT EXISTS folders_project_id_idx ON folders(project_id)",
  "CREATE INDEX IF NOT EXISTS folders_parent_id_idx ON folders(parent_id)",

  // 11. Sibling uniqueness partial indexes
  "CREATE UNIQUE INDEX IF NOT EXISTS folders_global_root_unique_idx ON folders(name_normalized) WHERE parent_id IS NULL AND project_id IS NULL",
  "CREATE UNIQUE INDEX IF NOT EXISTS folders_project_root_unique_idx ON folders(project_id, name_normalized) WHERE parent_id IS NULL AND project_id IS NOT NULL",
  "CREATE UNIQUE INDEX IF NOT EXISTS folders_subfolder_unique_idx ON folders(parent_id, name_normalized) WHERE parent_id IS NOT NULL",

  // 12. Trigger to ensure name_normalized is automatically synced with NFKC on insert or rename
  `CREATE OR REPLACE FUNCTION sync_folder_name_normalized()
   RETURNS TRIGGER AS $$
   BEGIN
     IF NEW.name IS NOT NULL THEN
       NEW.name_normalized := LOWER(TRIM(NORMALIZE(NEW.name, NFKC)));
     END IF;
     RETURN NEW;
   END;
   $$ LANGUAGE plpgsql`,
  "DROP TRIGGER IF EXISTS trg_sync_folder_name_normalized ON folders",
  "CREATE TRIGGER trg_sync_folder_name_normalized BEFORE INSERT OR UPDATE OF name ON folders FOR EACH ROW EXECUTE FUNCTION sync_folder_name_normalized()",

  // 13. Trigger to enforce child folder scope matches parent folder scope (bidirectional: protects child and parent mutations)
  `CREATE OR REPLACE FUNCTION check_folder_scope_integrity()
   RETURNS TRIGGER AS $$
   DECLARE
     parent_proj UUID;
     child_count INT;
     gen_count INT;
   BEGIN
     -- 1. If child folder has parent, verify child's project matches parent's project
     IF NEW.parent_id IS NOT NULL THEN
       SELECT project_id INTO parent_proj FROM folders WHERE id = NEW.parent_id;
       IF NOT FOUND THEN
         RAISE EXCEPTION 'Parent folder % does not exist', NEW.parent_id USING ERRCODE = 'foreign_key_violation';
       END IF;
       IF NEW.project_id IS DISTINCT FROM parent_proj THEN
         RAISE EXCEPTION 'Folder scope mismatch: child project_id (%) does not match parent project_id (%)',
           NEW.project_id, parent_proj USING ERRCODE = 'check_violation';
       END IF;
     END IF;

     -- 2. If folder project_id was updated directly, verify all child folders match NEW.project_id
     IF TG_OP = 'UPDATE' AND NEW.project_id IS DISTINCT FROM OLD.project_id THEN
       SELECT count(*)::int INTO child_count
       FROM folders
       WHERE parent_id = NEW.id AND project_id IS DISTINCT FROM NEW.project_id;

       IF child_count > 0 THEN
         RAISE EXCEPTION 'Folder scope mismatch: parent project_id (%) update leaves % child folders with mismatched scope',
           NEW.project_id, child_count USING ERRCODE = 'check_violation';
       END IF;

       -- Also verify any generations in this folder match NEW.project_id
       SELECT count(*)::int INTO gen_count
       FROM generations
       WHERE folder_id = NEW.id AND project_id IS DISTINCT FROM NEW.project_id;

       IF gen_count > 0 THEN
         RAISE EXCEPTION 'Generation scope mismatch: folder project_id (%) update leaves % generations with mismatched scope',
           NEW.project_id, gen_count USING ERRCODE = 'check_violation';
       END IF;
     END IF;

     RETURN NEW;
   END;
   $$ LANGUAGE plpgsql`,
  "DROP TRIGGER IF EXISTS trg_check_folder_scope ON folders",
  "CREATE CONSTRAINT TRIGGER trg_check_folder_scope AFTER INSERT OR UPDATE OF parent_id, project_id ON folders DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_folder_scope_integrity()",

  // 14. Trigger to enforce generation project matches referenced folder project
  `CREATE OR REPLACE FUNCTION check_generation_scope_integrity()
   RETURNS TRIGGER AS $$
   DECLARE
     folder_proj UUID;
   BEGIN
     IF NEW.folder_id IS NOT NULL THEN
       SELECT project_id INTO folder_proj FROM folders WHERE id = NEW.folder_id;
       IF NOT FOUND THEN
         RAISE EXCEPTION 'Referenced folder % does not exist', NEW.folder_id USING ERRCODE = 'foreign_key_violation';
       END IF;
       IF NEW.project_id IS DISTINCT FROM folder_proj THEN
         RAISE EXCEPTION 'Generation scope mismatch: generation project_id (%) does not match folder project_id (%)',
           NEW.project_id, folder_proj USING ERRCODE = 'check_violation';
       END IF;
     END IF;
     RETURN NEW;
   END;
   $$ LANGUAGE plpgsql`,
  "DROP TRIGGER IF EXISTS trg_check_generation_scope ON generations",
  "CREATE CONSTRAINT TRIGGER trg_check_generation_scope AFTER INSERT OR UPDATE OF folder_id, project_id ON generations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_generation_scope_integrity()",

  // 15. Organization idempotency keys table with full reservation and payload tracking
  `CREATE TABLE IF NOT EXISTS organization_idempotency_keys (
     key TEXT PRIMARY KEY,
     actor_id TEXT,
     operation TEXT NOT NULL DEFAULT 'unknown',
     fingerprint TEXT NOT NULL DEFAULT '',
     status TEXT NOT NULL DEFAULT 'completed',
     result JSONB,
     created_at BIGINT NOT NULL,
     expires_at BIGINT NOT NULL DEFAULT 0
   )`,
  "ALTER TABLE organization_idempotency_keys ADD COLUMN IF NOT EXISTS actor_id TEXT",
  "ALTER TABLE organization_idempotency_keys ADD COLUMN IF NOT EXISTS operation TEXT NOT NULL DEFAULT 'unknown'",
  "ALTER TABLE organization_idempotency_keys ADD COLUMN IF NOT EXISTS fingerprint TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE organization_idempotency_keys ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'completed'",
  "ALTER TABLE organization_idempotency_keys ADD COLUMN IF NOT EXISTS expires_at BIGINT NOT NULL DEFAULT 0",
  "CREATE INDEX IF NOT EXISTS organization_idempotency_keys_created_idx ON organization_idempotency_keys(created_at)",
  "CREATE INDEX IF NOT EXISTS organization_idempotency_keys_expires_idx ON organization_idempotency_keys(expires_at)",
  "CREATE INDEX IF NOT EXISTS organization_idempotency_keys_actor_op_idx ON organization_idempotency_keys(actor_id, operation)",
];

async function main() {
  const db = await getDb();
  console.log("Applying hierarchical folders additive migration...");

  for (const statement of HIERARCHICAL_FOLDER_STATEMENTS) {
    await db.execute(sql.raw(statement));
  }

  // Verification queries
  const folderCols = await db.execute(sql`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_name = 'folders'
      AND column_name IN ('parent_id', 'name_normalized', 'version', 'updated_at');
  `);
  const genCols = await db.execute(sql`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_name = 'generations'
      AND column_name = 'location_version';
  `);

  const folderCount = (folderCols.rows ?? folderCols).length;
  const genCount = (genCols.rows ?? genCols).length;

  if (folderCount === 4 && genCount === 1) {
    console.log("hierarchical folders migration successfully verified");
  } else {
    throw new Error(`Migration verification failed: folderCount=${folderCount}/4, genCount=${genCount}/1`);
  }
}

if (process.argv[1] && process.argv[1].endsWith("migrate-hierarchical-folders.js")) {
  main().catch((error) => {
    console.error(error?.message || error);
    process.exitCode = 1;
  });
}
