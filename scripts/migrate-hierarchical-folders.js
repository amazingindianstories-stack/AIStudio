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

  // 7. Backfill normalized name from display name
  "UPDATE folders SET name_normalized = LOWER(TRIM(name)) WHERE name_normalized IS NULL OR name_normalized = ''",
  "ALTER TABLE folders ALTER COLUMN name_normalized SET DEFAULT ''",
  "ALTER TABLE folders ALTER COLUMN name_normalized SET NOT NULL",

  // 8. Backfill updated_at from created_at
  "UPDATE folders SET updated_at = created_at WHERE updated_at = 0 OR updated_at IS NULL",
  "ALTER TABLE folders ALTER COLUMN updated_at SET DEFAULT 0",

  // 9. Hierarchy navigation and foreign-key indexes
  "CREATE INDEX IF NOT EXISTS folders_project_id_idx ON folders(project_id)",
  "CREATE INDEX IF NOT EXISTS folders_parent_id_idx ON folders(parent_id)",

  // 10. Sibling uniqueness partial indexes
  "CREATE UNIQUE INDEX IF NOT EXISTS folders_global_root_unique_idx ON folders(name_normalized) WHERE parent_id IS NULL AND project_id IS NULL",
  "CREATE UNIQUE INDEX IF NOT EXISTS folders_project_root_unique_idx ON folders(project_id, name_normalized) WHERE parent_id IS NULL AND project_id IS NOT NULL",
  "CREATE UNIQUE INDEX IF NOT EXISTS folders_subfolder_unique_idx ON folders(parent_id, name_normalized) WHERE parent_id IS NOT NULL",

  // 11. Trigger to ensure name_normalized is automatically synced even for raw legacy inserts
  `CREATE OR REPLACE FUNCTION sync_folder_name_normalized()
   RETURNS TRIGGER AS $$
   BEGIN
     IF NEW.name IS NOT NULL AND (NEW.name_normalized IS NULL OR NEW.name_normalized = '') THEN
       NEW.name_normalized := lower(trim(NEW.name));
     END IF;
     RETURN NEW;
   END;
   $$ LANGUAGE plpgsql`,
  "DROP TRIGGER IF EXISTS trg_sync_folder_name_normalized ON folders",
  "CREATE TRIGGER trg_sync_folder_name_normalized BEFORE INSERT OR UPDATE OF name ON folders FOR EACH ROW EXECUTE FUNCTION sync_folder_name_normalized()",
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
