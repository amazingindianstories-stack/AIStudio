/**
 * Re-check video generations that were failed by the age-based timeout bug and
 * restore any the provider actually finished.
 *
 * WHY THIS EXISTS
 *   Until f02be27, /api/generate/video/status applied its 30-minute timeout
 *   *before* polling the provider. Since polling stops when the tab is closed
 *   and resumes when the user returns, the first poll after the 30-minute mark
 *   failed the row without ever asking BytePlus — so a finished, already-billed
 *   video could be replaced by "Generation timed out" and never re-checked,
 *   because the row was terminal. This walks those rows back.
 *
 * FREE TO RUN. Querying a task's status costs nothing (it is not a generation),
 * and downloading a result the account already paid for costs nothing. No
 * request here can create a new job.
 *
 * DRY RUN BY DEFAULT — prints what it would do and writes nothing. Pass
 * --apply to actually repair rows.
 *
 *   npm run recover:videos
 *   npm run recover:videos -- --apply
 *
 * The `--tsconfig jsconfig.json` in that npm script is required, not optional:
 * this imports higgsfield-mcp.js, which imports `@/lib/storage`, and tsx only
 * auto-discovers a file literally named tsconfig.json — which this repo deleted
 * in the TS→JS conversion. Without it the run dies on "Cannot find module
 * '@/lib/storage'" before reaching any of the logic.
 *
 * EXPECT MISSES. Provider result URLs expire (BytePlus well inside a day), so
 * a row whose video finished long ago will report `succeeded` with a URL that
 * no longer downloads. That is recorded as "expired" and the row is left
 * failed — a row is only ever rewritten to succeeded once the bytes are
 * actually stored, so a partial recovery can never leave a card pointing at
 * nothing. Safe to re-run.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { and, desc, eq, ilike, isNotNull } from "drizzle-orm";
import { getDb } from "../src/lib/db";
import { generations } from "../src/lib/schema";
import { getVideoTask } from "../src/lib/providers/seedance";
import { isHiggsfieldModel, mcpJobStatus } from "../src/lib/providers/higgsfield-mcp";
import { isOmniModel } from "../src/lib/providers/omni";
import { saveFromUrl } from "../src/lib/save-media";
import { getItem, upsertItem } from "../src/lib/store-db";

const APPLY = process.argv.includes("--apply");

/** The exact text the buggy path wrote. Scoped to it deliberately: a video
 *  that failed for any other reason failed for a real reason. */
const TIMEOUT_ERROR = "never returned a result";

async function providerStatus(item) {
  if (isOmniModel(item.model)) {
    // Omni returns the video inline as base64 on the interaction, and does not
    // re-serve a completed one on a later poll (see the route's own note), so
    // there is nothing left to recover once that response was missed.
    return { status: "unrecoverable", reason: "Omni does not re-serve a finished interaction" };
  }
  const result = isHiggsfieldModel(item.model)
    ? await mcpJobStatus(item.taskId)
    : await getVideoTask(item.taskId);
  return { status: result.status, url: result.url ?? result.videoUrl, error: result.error };
}

async function main() {
  const db = await getDb();
  const rows = await db
    .select()
    .from(generations)
    .where(
      and(
        eq(generations.kind, "video"),
        eq(generations.status, "failed"),
        ilike(generations.error, `%${TIMEOUT_ERROR}%`),
        isNotNull(generations.taskId)
      )
    )
    .orderBy(desc(generations.createdAt));

  console.log(
    `${rows.length} timed-out video row(s) with a task id` +
      `${APPLY ? "" : "  (dry run — pass --apply to repair)"}\n`
  );
  if (!rows.length) return process.exit(0);

  const tally = { recovered: 0, expired: 0, reallyFailed: 0, stillRunning: 0, unrecoverable: 0, errored: 0 };

  for (const r of rows) {
    const age = ((Date.now() - Number(r.createdAt)) / 3600_000).toFixed(1);
    const label = `${new Date(Number(r.createdAt)).toISOString()}  ${r.model}  ${r.id.slice(0, 8)}  (${age}h old)`;
    let res;
    try {
      res = await providerStatus(r);
    } catch (e) {
      tally.errored++;
      console.log(`  ERROR      ${label}\n             ${String(e?.message || e).slice(0, 140)}`);
      continue;
    }

    if (res.status === "unrecoverable") {
      tally.unrecoverable++;
      console.log(`  SKIP       ${label}\n             ${res.reason}`);
      continue;
    }
    if (res.status === "failed") {
      // The provider did fail it — the row's outcome was right even though its
      // message was invented. Replace the message with the real one so the
      // card stops implying a timeout that never happened.
      tally.reallyFailed++;
      console.log(`  TRUE FAIL  ${label}\n             provider says: ${String(res.error || "failed").slice(0, 120)}`);
      if (APPLY) {
        const item = await getItem(r.id);
        await upsertItem({ ...item, status: "failed", error: res.error || "Generation failed.", updatedAt: Date.now() });
      }
      continue;
    }
    if (res.status !== "succeeded" || !res.url) {
      tally.stillRunning++;
      console.log(`  PENDING    ${label}\n             provider still reports ${res.status} — left alone`);
      continue;
    }

    // Succeeded. The bytes are the whole point, so download BEFORE rewriting
    // the row: a succeeded row pointing at an expired provider URL is worse
    // than the failed row it replaced.
    if (!APPLY) {
      tally.recovered++;
      console.log(`  RECOVER    ${label}\n             provider has a result — would download and restore`);
      continue;
    }
    try {
      const localUrl = await saveFromUrl(res.url, "mp4", r.id);
      const item = await getItem(r.id);
      await upsertItem({ ...item, status: "succeeded", url: localUrl, error: undefined, updatedAt: Date.now() });
      tally.recovered++;
      console.log(`  RECOVERED  ${label}\n             stored ${localUrl}`);
    } catch (e) {
      tally.expired++;
      console.log(
        `  EXPIRED    ${label}\n             provider reported success but the URL no longer downloads: ` +
          `${String(e?.message || e).slice(0, 100)}`
      );
    }
  }

  console.log(
    `\n${APPLY ? "applied" : "would apply"} — recovered ${tally.recovered}, expired ${tally.expired}, ` +
      `genuinely failed ${tally.reallyFailed}, still pending ${tally.stillRunning}, ` +
      `unrecoverable ${tally.unrecoverable}, errored ${tally.errored}`
  );
  process.exit(0);
}

main();
