import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { and, eq, isNull, isNotNull } from "drizzle-orm";
import { getDb } from "../src/lib/db";
import { generations } from "../src/lib/schema";
import { saveGenerationThumbnail } from "../src/lib/save-media";
import { mediaKeyFromRef, readStoredBuffer } from "../src/lib/storage";

const CONCURRENCY = 4; // matches MAX_CONCURRENT_CANVAS_IMAGES

/**
 * Idempotent one-off backfill for existing `generations` rows: finds
 * succeeded images with no stored thumbnail yet, generates + stores
 * thumbnail/blur for each with bounded concurrency, and continues past
 * individual row failures rather than aborting the run. Safe to run
 * repeatedly (already-backfilled rows are skipped via the `thumbnailUrl IS
 * NULL` predicate).
 *
 * Not run by the council — see .council/thumbnail-pipeline/design.md's
 * Rollout constraint. Run manually after `npm run db:push` + deploy:
 *   npx tsx scripts/backfill-thumbnails.ts
 */
async function main() {
  const db = await getDb();
  const rows = await db.select({ id: generations.id, url: generations.url })
    .from(generations)
    .where(and(
      eq(generations.kind, "image"),
      eq(generations.status, "succeeded"),
      isNull(generations.thumbnailUrl),
      isNotNull(generations.url),
    ));
  console.log(`[backfill] ${rows.length} rows to process`);

  let ok = 0, skipped = 0, failed = 0, i = 0;
  async function worker() {
    while (i < rows.length) {
      const row = rows[i++];
      try {
        const key = mediaKeyFromRef(row.url!);
        if (!key) { skipped++; continue; }
        const bytes = await readStoredBuffer(key);
        const { thumbnailUrl, blurDataUrl } = await saveGenerationThumbnail(bytes, row.id);
        await db.update(generations)
          .set({ thumbnailUrl, blurDataUrl, updatedAt: Date.now() })
          .where(eq(generations.id, row.id));
        ok++;
      } catch (e) {
        failed++;
        console.warn(`[backfill] ${row.id} failed:`, (e as Error).message);
      }
      if ((ok + skipped + failed) % 25 === 0) {
        console.log(`[backfill] progress ${ok + skipped + failed}/${rows.length}`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  console.log(`[backfill] done: ok=${ok} skipped=${skipped} failed=${failed}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
