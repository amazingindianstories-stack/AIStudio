import { config } from "dotenv";
import { sql } from "drizzle-orm";
import { getDb } from "../src/lib/db.js";

config({ path: process.env.ENV_FILE || ".env.local" });
export const GENERATION_NAMING_STATEMENTS = [
  // 0. Ensure media_exports has manifest_version
  "ALTER TABLE media_exports ADD COLUMN IF NOT EXISTS manifest_version INTEGER NOT NULL DEFAULT 1",

  // 1. Create naming_counters table for durable sequence tracking per namespace
  `CREATE TABLE IF NOT EXISTS naming_counters (
    namespace TEXT PRIMARY KEY,
    next_sequence BIGINT NOT NULL DEFAULT 1,
    updated_at BIGINT NOT NULL
  )`,

  // 2. Create generation_naming table for immutable assignment records
  `CREATE TABLE IF NOT EXISTS generation_naming (
    generation_id UUID PRIMARY KEY REFERENCES generations(id) ON DELETE CASCADE,
    namespace TEXT NOT NULL,
    sequence BIGINT NOT NULL,
    assigned_at BIGINT NOT NULL
  )`,

  // 3. Unique index on (namespace, sequence)
  "CREATE UNIQUE INDEX IF NOT EXISTS generation_naming_namespace_seq_idx ON generation_naming(namespace, sequence)",

  // 4. Index on namespace for fast filtering/counts
  "CREATE INDEX IF NOT EXISTS generation_naming_namespace_idx ON generation_naming(namespace)",

  // 5. Positive sequence check constraint
  `DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = 'generation_naming'::regclass
        AND conname = 'generation_naming_sequence_check'
    ) THEN
      ALTER TABLE generation_naming ADD CONSTRAINT generation_naming_sequence_check CHECK (sequence > 0);
    END IF;
  END $$;`,

  // 6. Explicit foreign key with CASCADE on delete
  `DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = 'generation_naming'::regclass
        AND conname = 'generation_naming_generation_id_fkey'
    ) THEN
      ALTER TABLE generation_naming ADD CONSTRAINT generation_naming_generation_id_fkey
        FOREIGN KEY (generation_id) REFERENCES generations(id) ON DELETE CASCADE;
    END IF;
  END $$;`,

  // 7. Bidirectional scope integrity trigger function
  `CREATE OR REPLACE FUNCTION check_generation_naming_scope_integrity()
   RETURNS TRIGGER AS $$
   DECLARE
     gen_folder UUID;
     gen_project UUID;
     expected_ns TEXT;
   BEGIN
     IF TG_TABLE_NAME = 'generation_naming' THEN
       SELECT folder_id, project_id INTO gen_folder, gen_project
       FROM generations WHERE id = NEW.generation_id;
       IF NOT FOUND THEN
         RETURN NEW;
       END IF;

       IF gen_folder IS NOT NULL THEN
         expected_ns := 'folder:' || gen_folder::text;
       ELSIF gen_project IS NOT NULL THEN
         expected_ns := 'project_unsorted:' || gen_project::text;
       ELSE
         expected_ns := 'global_unsorted';
       END IF;

       IF NEW.namespace IS DISTINCT FROM expected_ns THEN
         RAISE EXCEPTION 'Naming namespace mismatch: namespace (%) does not match generation (%) location (%)',
           NEW.namespace, NEW.generation_id, expected_ns USING ERRCODE = 'check_violation';
       END IF;
       RETURN NEW;

     ELSIF TG_TABLE_NAME = 'generations' THEN
       IF TG_OP = 'UPDATE' AND (NEW.folder_id IS DISTINCT FROM OLD.folder_id OR NEW.project_id IS DISTINCT FROM OLD.project_id) THEN
         IF NEW.folder_id IS NOT NULL THEN
           expected_ns := 'folder:' || NEW.folder_id::text;
         ELSIF NEW.project_id IS NOT NULL THEN
           expected_ns := 'project_unsorted:' || NEW.project_id::text;
         ELSE
           expected_ns := 'global_unsorted';
         END IF;

         IF EXISTS (
           SELECT 1 FROM generation_naming
           WHERE generation_id = NEW.id AND namespace IS DISTINCT FROM expected_ns
         ) THEN
           RAISE EXCEPTION 'Direct generation move violates naming assignment: generation (%) moved to (%) but naming assignment is in another namespace',
             NEW.id, expected_ns USING ERRCODE = 'check_violation';
         END IF;
       END IF;
       RETURN NEW;
     END IF;

     RETURN NEW;
   END;
   $$ LANGUAGE plpgsql`,

  // 8. Attach deferred constraint trigger on generation_naming
  "DROP TRIGGER IF EXISTS trg_check_generation_naming_scope ON generation_naming",
  `CREATE CONSTRAINT TRIGGER trg_check_generation_naming_scope
   AFTER INSERT OR UPDATE ON generation_naming
   DEFERRABLE INITIALLY DEFERRED
   FOR EACH ROW
   EXECUTE FUNCTION check_generation_naming_scope_integrity()`,

  // 9. Attach deferred constraint trigger on generations
  "DROP TRIGGER IF EXISTS trg_check_generation_location_naming ON generations",
  `CREATE CONSTRAINT TRIGGER trg_check_generation_location_naming
   AFTER UPDATE OF folder_id, project_id ON generations
   DEFERRABLE INITIALLY DEFERRED
   FOR EACH ROW
   EXECUTE FUNCTION check_generation_naming_scope_integrity()`,

  // 10. Deterministic backfill of unassigned generations (strictly ordered by created_at ASC, id ASC)
  `WITH unassigned AS (
    SELECT
      g.id AS generation_id,
      CASE
        WHEN g.folder_id IS NOT NULL THEN 'folder:' || g.folder_id::text
        WHEN g.project_id IS NOT NULL THEN 'project_unsorted:' || g.project_id::text
        ELSE 'global_unsorted'
      END AS namespace,
      g.created_at
    FROM generations g
    LEFT JOIN generation_naming gn ON g.id = gn.generation_id
    WHERE gn.generation_id IS NULL
  ),
  allocated AS (
    SELECT
      u.generation_id,
      u.namespace,
      COALESCE(c.max_seq, 0) + ROW_NUMBER() OVER (
        PARTITION BY u.namespace
        ORDER BY u.created_at ASC, u.generation_id ASC
      ) AS sequence,
      ROUND(EXTRACT(EPOCH FROM NOW()) * 1000)::bigint AS assigned_at
    FROM unassigned u
    LEFT JOIN (
      SELECT namespace, MAX(sequence) AS max_seq
      FROM generation_naming
      GROUP BY namespace
    ) c ON u.namespace = c.namespace
  )
  INSERT INTO generation_naming (generation_id, namespace, sequence, assigned_at)
  SELECT generation_id, namespace, sequence, assigned_at
  FROM allocated
  ON CONFLICT (generation_id) DO NOTHING`,

  // 11. Seed / update naming_counters for all active namespaces
  `INSERT INTO naming_counters (namespace, next_sequence, updated_at)
   SELECT
     namespace,
     COALESCE(MAX(sequence), 0) + 1 AS next_sequence,
     ROUND(EXTRACT(EPOCH FROM NOW()) * 1000)::bigint AS updated_at
   FROM generation_naming
   GROUP BY namespace
   ON CONFLICT (namespace) DO UPDATE
   SET next_sequence = GREATEST(naming_counters.next_sequence, EXCLUDED.next_sequence),
       updated_at = EXCLUDED.updated_at`,

  // 12. Seed empty folders, projects, and global unsorted if not already present
  `INSERT INTO naming_counters (namespace, next_sequence, updated_at)
   SELECT 'folder:' || id::text, 1, ROUND(EXTRACT(EPOCH FROM NOW()) * 1000)::bigint
   FROM folders
   ON CONFLICT (namespace) DO NOTHING`,

  `INSERT INTO naming_counters (namespace, next_sequence, updated_at)
   SELECT 'project_unsorted:' || id::text, 1, ROUND(EXTRACT(EPOCH FROM NOW()) * 1000)::bigint
   FROM projects
   ON CONFLICT (namespace) DO NOTHING`,

  `INSERT INTO naming_counters (namespace, next_sequence, updated_at)
   VALUES ('global_unsorted', 1, ROUND(EXTRACT(EPOCH FROM NOW()) * 1000)::bigint)
   ON CONFLICT (namespace) DO NOTHING`,
];

/**
 * Executes the generation naming migration with verification.
 */
export async function migrateGenerationNaming(customDb = null) {
  const db = customDb || (await getDb());
  console.log("Starting generation naming migration...");

  for (let i = 0; i < GENERATION_NAMING_STATEMENTS.length; i++) {
    const stmt = GENERATION_NAMING_STATEMENTS[i];
    await db.execute(sql.raw(stmt));
  }

  // Verification post-migration
  const unassignedRes = await db.execute(sql`
    SELECT count(*)::int as count
    FROM generations g
    LEFT JOIN generation_naming gn ON g.id = gn.generation_id
    WHERE gn.generation_id IS NULL;
  `);
  const unassignedCount = Number((unassignedRes.rows ?? unassignedRes)[0]?.count || 0);
  if (unassignedCount > 0) {
    throw new Error(`Migration verification failed: ${unassignedCount} generations remain unassigned in generation_naming.`);
  }

  const dupRes = await db.execute(sql`
    SELECT namespace, sequence, count(*)::int as count
    FROM generation_naming
    GROUP BY namespace, sequence
    HAVING count(*) > 1;
  `);
  const dupCount = (dupRes.rows ?? dupRes).length;
  if (dupCount > 0) {
    throw new Error(`Migration verification failed: found ${dupCount} duplicate sequence assignments.`);
  }

  const counterLagRes = await db.execute(sql`
    SELECT gn.namespace, MAX(gn.sequence)::bigint as max_seq, nc.next_sequence
    FROM generation_naming gn
    JOIN naming_counters nc ON gn.namespace = nc.namespace
    GROUP BY gn.namespace, nc.next_sequence
    HAVING nc.next_sequence <= MAX(gn.sequence);
  `);
  const lagCount = (counterLagRes.rows ?? counterLagRes).length;
  if (lagCount > 0) {
    throw new Error(`Migration verification failed: ${lagCount} counters lag behind max assigned sequence.`);
  }

  console.log("Generation naming migration completed and verified successfully.");
  return { success: true };
}

if (process.argv[1] && process.argv[1].endsWith("migrate-generation-naming.js")) {
  migrateGenerationNaming()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error("Migration failed:", error);
      process.exit(1);
    });
}
