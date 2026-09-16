import { config } from "dotenv";
import { sql } from "drizzle-orm";
import { getDb } from "../src/lib/db.js";

config({ path: process.env.ENV_FILE || ".env.local" });

// Additive and idempotent migration for BytePlus ModelArk Portrait Gallery tables.
async function main() {
  const db = await getDb();
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS portrait_groups (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      byteplus_group_id TEXT UNIQUE,
      name TEXT NOT NULL,
      description TEXT,
      group_type TEXT NOT NULL DEFAULT 'AIGC',
      project_name TEXT NOT NULL DEFAULT 'default',
      primary_asset_id TEXT,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS portrait_assets (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      group_id UUID NOT NULL REFERENCES portrait_groups(id) ON DELETE CASCADE,
      byteplus_asset_id TEXT UNIQUE,
      name TEXT,
      asset_type TEXT NOT NULL DEFAULT 'Image',
      role TEXT NOT NULL DEFAULT 'reference',
      image_url TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'Processing',
      status_message TEXT,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_portrait_assets_group_id ON portrait_assets(group_id);
  `));
  console.log("portrait_groups and portrait_assets tables are ready");
  process.exit(0);
}

main().catch((error) => {
  console.error("Portrait gallery migration failed:", error);
  process.exit(1);
});
