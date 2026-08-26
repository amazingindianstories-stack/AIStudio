import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { EXPECTED_GENERATION_INDEX_NAMES } from "@/lib/generation-indexes";

export const STUCK_IMAGE_MS = 10 * 60 * 1000;
export const STUCK_VIDEO_MS = 45 * 60 * 1000;
export const STUCK_DEPTH_GRACE_MS = 2 * 60 * 1000;
export const DEPTH_WORKER_STALE_MS = 45_000;

function resultRows(result) {
  return result?.rows ?? result ?? [];
}

export async function checkGenerationIndexes(dbProvider = getDb) {
  const db = await dbProvider();
  const result = await db.execute(sql`
    select i.relname as name, x.indisvalid as valid
      from pg_index x
      join pg_class i on i.oid = x.indexrelid
      join pg_class t on t.oid = x.indrelid
      join pg_namespace n on n.oid = t.relnamespace
     where n.nspname = current_schema()
       and t.relname = 'generations'
  `);
  const actual = new Map(resultRows(result).map((row) => [row.name, Boolean(row.valid)]));
  const missing = EXPECTED_GENERATION_INDEX_NAMES.filter((name) => !actual.has(name));
  const invalid = EXPECTED_GENERATION_INDEX_NAMES.filter((name) => actual.get(name) === false);
  if (missing.length || invalid.length) {
    const parts = [];
    if (missing.length) parts.push(`missing: ${missing.join(", ")}`);
    if (invalid.length) parts.push(`invalid: ${invalid.join(", ")}`);
    return { status: "error", detail: parts.join("; ") };
  }
  return {
    status: "ok",
    detail: `${EXPECTED_GENERATION_INDEX_NAMES.length}/${EXPECTED_GENERATION_INDEX_NAMES.length} expected indexes valid`,
  };
}

function ageLabel(ageMs) {
  return `${Math.max(0, Math.floor(ageMs / 60_000))}m`;
}

export async function checkStuckGenerations(dbProvider = getDb, now = Date.now()) {
  const db = await dbProvider();
  const result = await db.execute(sql`
    with stuck as (
      select g.kind, g.updated_at
        from generations g
       where g.status = 'running'
         and (
           (g.kind = 'image' and g.updated_at < ${now - STUCK_IMAGE_MS})
           or (g.kind = 'video' and g.updated_at < ${now - STUCK_VIDEO_MS})
           or (
             g.kind = 'depth'
             and g.updated_at < ${now - STUCK_DEPTH_GRACE_MS}
             and not exists (
               select 1
                 from depth_workers w
                where w.worker_id = g.depth_claim_worker_id
                  and w.current_job_id = g.id
                  and w.current_claim_id = g.depth_claim_id
                  and w.last_seen_at >= ${now - DEPTH_WORKER_STALE_MS}
             )
           )
         )
    )
    select kind, count(*)::int as count, min(updated_at)::bigint as oldest_updated_at
      from stuck
     group by kind
     order by kind
  `);
  const rows = resultRows(result);
  if (!rows.length) return { status: "ok", detail: "No stuck running generations" };
  const total = rows.reduce((sum, row) => sum + Number(row.count), 0);
  const summary = rows.map(
    (row) => `${row.kind}: ${Number(row.count)} (oldest ${ageLabel(now - Number(row.oldest_updated_at))})`
  );
  return { status: "error", detail: `${total} stuck — ${summary.join("; ")}` };
}
