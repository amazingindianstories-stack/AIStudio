/**
 * Turns flagged generations (Phase 3.5's "flag this generation" signal) into
 * runnable scripts/eval-fixtures/*.fixture.json files for
 * `npm run eval:regression` (Phase 3.4) — this is the "feeding 3.4's fixture
 * set over time" half of the plan. Nothing here is automatic: a human still
 * decides which exported fixtures are worth keeping, edits `samples`/prompt
 * if needed, and runs `--update-floors` once to establish a baseline. This
 * script's job is only to remove the manual "download the reference image
 * and hand-copy the prompt/model/aspect-ratio" busywork.
 *
 * FREE TO RUN — no billed API calls. It only reads already-flagged rows from
 * Postgres and already-stored reference images from S3/GCS (via the same
 * readImageAsBase64 queue/execute itself uses, so no signed-URL round trip
 * or extra credentials are needed beyond what this app already has).
 *
 * Only image-kind rows are exported. eval-regression.js's harness only
 * exercises the image pipeline (assemblePrompt → generateImageGemini) —
 * there is no video-fixture equivalent today, so a flagged video/depth row
 * is reported and skipped rather than silently producing a fixture the
 * harness can't actually run.
 *
 * A flagged row with no reference images is also skipped: eval-regression.js
 * (like ab-face-eval.js before it) judges identity against a reference face,
 * so a fixture with nothing to compare against can't mean anything — same
 * hard requirement runFixture() itself enforces.
 *
 * Usage:
 *   npm run export:flagged-fixtures
 *   npm run export:flagged-fixtures -- --force   # overwrite already-exported fixtures
 *   npm run export:flagged-fixtures -- --limit=10
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { promises as fs } from "node:fs";
import path from "node:path";
import { desc, eq, and } from "drizzle-orm";
import { getDb } from "../src/lib/db";
import { generations } from "../src/lib/schema";
import { readImageAsBase64 } from "../src/lib/save-media";

const FIXTURES_DIR = path.join(process.cwd(), "scripts", "eval-fixtures");

const args = process.argv.slice(2);
const FORCE = args.includes("--force");
const limitArg = args.find((a) => a.startsWith("--limit="))?.split("=")[1];
const LIMIT = Number.isFinite(Number(limitArg)) ? Number(limitArg) : 50;

function extFromMime(mimeType) {
  if (mimeType?.includes("webp")) return "webp";
  if (mimeType?.includes("jpeg") || mimeType?.includes("jpg")) return "jpg";
  if (mimeType?.includes("gif")) return "gif";
  return "png";
}

async function main() {
  const db = await getDb();
  const rows = await db
    .select()
    .from(generations)
    .where(and(eq(generations.flagged, true), eq(generations.kind, "image")))
    .orderBy(desc(generations.flaggedAt))
    .limit(LIMIT);

  if (!rows.length) {
    console.log(
      "No flagged image generations found. Flag one from the app's detail " +
        "view (the flag icon next to Favourite) and re-run."
    );
    return;
  }

  await fs.mkdir(FIXTURES_DIR, { recursive: true });

  let exported = 0;
  let skippedNoRef = 0;
  let skippedExists = 0;
  let failed = 0;

  for (const row of rows) {
    const label = `${row.id.slice(0, 8)}  ${row.model}  "${row.prompt.slice(0, 60)}${row.prompt.length > 60 ? "…" : ""}"`;
    const slug = `flagged-${row.id.slice(0, 8)}`;
    const fixturePath = path.join(FIXTURES_DIR, `${slug}.fixture.json`);

    if (!row.referenceImages || row.referenceImages.length === 0) {
      console.log(`  SKIP (no reference image)   ${label}`);
      skippedNoRef++;
      continue;
    }
    if (!FORCE) {
      try {
        await fs.access(fixturePath);
        console.log(`  SKIP (already exported)     ${label}`);
        skippedExists++;
        continue;
      } catch {
        // doesn't exist yet — proceed
      }
    }

    try {
      const { mimeType, data } = await readImageAsBase64(row.referenceImages[0]);
      const ext = extFromMime(mimeType);
      const refFilename = `${slug}-ref.${ext}`;
      await fs.writeFile(path.join(FIXTURES_DIR, refFilename), Buffer.from(data, "base64"));

      const fixture = {
        name: slug,
        prompt: row.prompt,
        referenceImages: [`./${refFilename}`],
        aspectRatio: row.aspectRatio,
        resolution: row.resolution || "2K",
        model: row.model,
        samples: 3,
        identityFloor: null,
        // Informational only — eval-regression.js's loadFixtures()/runFixture()
        // never reads these, they're context for whoever curates this fixture.
        _sourceGenerationId: row.id,
        _flaggedAt: row.flaggedAt,
        _flagReason: row.flagReason ?? null,
        _judgeScoreAtGeneration: row.judgeScore ?? null,
      };
      await fs.writeFile(fixturePath, JSON.stringify(fixture, null, 2) + "\n");
      console.log(`  EXPORTED                    ${label}`);
      exported++;
    } catch (e) {
      console.log(`  FAILED (${e?.message?.slice(0, 100)})  ${label}`);
      failed++;
    }
  }

  console.log(
    `\n${exported} exported, ${skippedExists} already existed, ` +
      `${skippedNoRef} had no reference image, ${failed} failed ` +
      `(of ${rows.length} flagged image row(s) checked).`
  );
  if (exported > 0) {
    console.log(
      `\nNext: review the new fixture(s) in scripts/eval-fixtures/, adjust ` +
        `prompt/samples if needed, then run\n` +
        `  npm run eval:regression -- --fixture=<name> --update-floors\n` +
        `once per fixture to establish its baseline.`
    );
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
