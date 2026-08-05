/**
 * Render the thumbnail ladder for media that predates it.
 *
 * `/api/media/[...path]?w=` serves a pre-rendered derivative and falls back to
 * rendering one on the spot when it is missing. That fallback is a correctness
 * net, not a plan: without this backfill the first person to open the library
 * after the deploy pays a sharp decode for every card on screen, all at once,
 * on the shared instance. Running this first means the read path is a pure
 * redirect from the very first request.
 *
 * Safe to re-run — existing derivatives are skipped, so a run interrupted
 * halfway just resumes. Dry run unless --apply is passed.
 *
 *   npx tsx scripts/backfill-thumbnails.ts            # report what is missing
 *   npx tsx scripts/backfill-thumbnails.ts -- --apply # write them
 *
 * Reads and writes the backend that MEDIA_BACKEND selects, exactly as the app
 * does; it has no separate credentials or bucket of its own.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import {
  listMediaKeys,
  objectExists,
  readStoredBuffer,
  saveThumbnailObject,
} from "../src/lib/storage";
import { isThumbnailable, THUMB_LADDER, thumbKey } from "../src/lib/media-derivatives";

const APPLY = process.argv.includes("--apply");
/** Bounded so a backfill can't saturate the machine or the storage API. */
const CONCURRENCY = Number(process.env.BACKFILL_CONCURRENCY || 6);

async function mapWithLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<void>
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}

async function main() {
  const keys = (await listMediaKeys()).filter(isThumbnailable);
  console.log(`${keys.length} thumbnailable objects; ladder ${THUMB_LADDER.join("/")}`);

  let missing = 0;
  let written = 0;
  let failed = 0;
  let done = 0;

  await mapWithLimit(keys, CONCURRENCY, async (key) => {
    const absent: number[] = [];
    for (const width of THUMB_LADDER) {
      if (!(await objectExists(thumbKey(key, width)))) absent.push(width);
    }
    if (absent.length) {
      missing += absent.length;
      if (APPLY) {
        try {
          // One read of the original serves every missing width.
          const source = await readStoredBuffer(key);
          const sharp = (await import("sharp")).default;
          for (const width of absent) {
            const out = await sharp(source, { failOn: "error", sequentialRead: true })
              .resize({ width, withoutEnlargement: true })
              .webp({ quality: 75 })
              .toBuffer();
            await saveThumbnailObject(out, key, width);
            written++;
          }
        } catch (e: any) {
          failed++;
          console.warn(`  ! ${key}: ${e?.message ?? e}`);
        }
      }
    }
    if (++done % 100 === 0) console.log(`  …${done}/${keys.length}`);
  });

  console.log(
    APPLY
      ? `wrote ${written} derivatives, ${failed} objects failed`
      : `${missing} derivatives missing across ${keys.length} objects — re-run with --apply`
  );
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  }
);
