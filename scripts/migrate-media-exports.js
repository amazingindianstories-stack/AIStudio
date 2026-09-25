import { config } from "dotenv";
import { sql } from "drizzle-orm";
import { getDb } from "../src/lib/db.js";

config({ path: process.env.ENV_FILE || ".env.local" });

async function main() {
  const db = await getDb();
  const statements = [
    `create table if not exists media_exports (
      id uuid primary key, user_id uuid not null, status text not null default 'draft',
      total_items integer not null default 0, processed_items integer not null default 0,
      skipped_items integer not null default 0, warnings jsonb not null default '[]'::jsonb,
      attempt_count integer not null default 0, lease_owner text, lease_until bigint,
      output_key text, output_bytes bigint, error text, created_at bigint not null,
      updated_at bigint not null, expires_at bigint
    )`,
    `create table if not exists media_export_items (
      export_id uuid not null references media_exports(id) on delete cascade,
      generation_id uuid not null, position integer not null, source_key text not null,
      filename text not null, primary key (export_id, generation_id)
    )`,
    `create index if not exists media_exports_user_created_idx on media_exports(user_id, created_at desc)`,
    `create index if not exists media_exports_worker_due_idx on media_exports(status, lease_until, created_at)`,
    `create index if not exists media_export_items_order_idx on media_export_items(export_id, position)`,
  ];
  for (const statement of statements) await db.execute(sql.raw(statement));
  console.log("media export migration verified");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
