import { getDb } from "../src/lib/db.js";
import { sql } from "drizzle-orm";
import { config } from "dotenv";

config({ path: process.env.ENV_FILE || ".env.local" });

// Online, idempotent migration to bind assets and portrait groups to projects.
async function main() {
  const db = await getDb();
  console.log("Starting project-bound assets migration...");

  const statements = [
    `alter table assets add column if not exists project_id uuid`,
    `create index if not exists assets_project_id_idx on assets (project_id)`,
    `alter table portrait_groups add column if not exists project_id uuid`,
    `create index if not exists portrait_groups_project_id_idx on portrait_groups (project_id)`,
    // Backfill legacy assets and groups to the primary project if any exist with NULL project_id
    `update assets set project_id = (select id from projects order by created_at asc limit 1) where project_id is null and exists (select 1 from projects)`,
    `update portrait_groups set project_id = (select id from projects order by created_at asc limit 1) where project_id is null and exists (select 1 from projects)`,
  ];

  for (const stmt of statements) {
    console.log(`Executing: ${stmt}`);
    await db.execute(sql.raw(stmt));
  }

  // Verification count
  const assetsCount = await db.execute(sql`select count(*)::int as count from assets where project_id is not null`);
  const groupsCount = await db.execute(sql`select count(*)::int as count from portrait_groups where project_id is not null`);

  console.log("Assets with project_id:", (assetsCount.rows ?? assetsCount)[0].count);
  console.log("Portrait groups with project_id:", (groupsCount.rows ?? groupsCount)[0].count);
  console.log("project-bound assets migration complete!");
  process.exit(0);
}

main().catch((error) => {
  console.error("project-bound assets migration failed:", error);
  process.exitCode = 1;
});
