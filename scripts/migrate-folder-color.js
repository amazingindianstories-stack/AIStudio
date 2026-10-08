import { config } from "dotenv";
import { sql } from "drizzle-orm";
import { getDb } from "../src/lib/db.js";

config({ path: process.env.ENV_FILE || ".env.local" });

export const FOLDER_COLOR_STATEMENTS = [
  "ALTER TABLE folders ADD COLUMN IF NOT EXISTS color TEXT",
  `DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint 
      WHERE conrelid = 'folders'::regclass AND conname = 'folders_color_check'
    ) THEN
      ALTER TABLE folders ADD CONSTRAINT folders_color_check 
        CHECK (color IS NULL OR color IN ('gray', 'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink'));
    END IF;
  END $$;`,
];

export async function migrateFolderColor(customDb = null) {
  const db = customDb || (await getDb());
  console.log("Applying folder color migration...");

  await db.transaction(async (tx) => {
    for (const stmt of FOLDER_COLOR_STATEMENTS) {
      await tx.execute(sql.raw(stmt));
    }
  });

  console.log("Folder color migration completed successfully.");
}

if (process.argv[1] && process.argv[1].endsWith("migrate-folder-color.js")) {
  migrateFolderColor()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Migration failed:", err);
      process.exit(1);
    });
}
