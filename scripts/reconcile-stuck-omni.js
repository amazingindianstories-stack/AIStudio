/**
 * Reconcile stale running Gemini Omni rows with provider-confirmed outcomes.
 * Dry-run is DB-only because a successful poll may carry non-refetchable bytes.
 */
import { config } from "dotenv";
config({ path: process.env.ENV_FILE || ".env.local" });

import { getDb } from "../src/lib/db";
import { saveBase64 } from "../src/lib/save-media";
import { getOmniVideoStatus } from "../src/lib/providers/omni";
import {
  classifyOmniReconciliationResult,
  finalizeRunningOmniRow,
  parseOmniReconcileArgs,
  selectStaleRunningOmniRows,
} from "../src/lib/stuck-omni-reconciliation";

const USAGE = `Usage: npm run reconcile:omni -- [options]

Options:
  --apply                 Poll and persist provider-confirmed terminal rows
  --min-age-minutes=N     Minimum idle age (default: 45; max: 10080)
  --max-rows=N            Maximum rows per run (default: 50; max: 500)
  --help                  Show this help

Without --apply this only lists database candidates and never contacts Google.`;

async function main() {
  const options = parseOmniReconcileArgs(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    return;
  }

  const db = await getDb();
  const rows = await selectStaleRunningOmniRows(db, options);
  console.log(
    `${rows.length} stale running Omni row(s), max ${options.maxRows}, ` +
      `idle at least ${options.minAgeMinutes}m` +
      `${options.apply ? "" : " (DB-only dry run; Google was not contacted)"}`
  );
  for (const row of rows) {
    const idleMinutes = Math.floor((Date.now() - Number(row.updatedAt)) / 60_000);
    console.log(`  CANDIDATE  …${row.id.slice(-8)}  ${idleMinutes}m idle`);
  }
  if (!options.apply || !rows.length) return;

  const tally = { failed: 0, succeeded: 0, pending: 0, raced: 0, errored: 0 };
  for (const row of rows) {
    const label = `…${row.id.slice(-8)}`;
    try {
      const result = await getOmniVideoStatus(row.taskId);
      const action = classifyOmniReconciliationResult(result);
      if (action === "pending") {
        tally.pending += 1;
        console.log(`  PENDING    ${label}  provider reports ${result?.status || "unknown"}`);
        continue;
      }

      let values;
      if (action === "failed") {
        values = {
          status: "failed",
          error: result.error || "Generation failed.",
          moderationBlocked: result.moderationBlocked === true,
          updatedAt: Date.now(),
        };
      } else {
        const ext = (result.mimeType || "").includes("webm") ? "webm" : "mp4";
        const url = await saveBase64(result.videoBase64, ext, row.id);
        values = { status: "succeeded", url, error: null, updatedAt: Date.now() };
      }

      const updated = await finalizeRunningOmniRow(db, {
        id: row.id,
        taskId: row.taskId,
        values,
      });
      if (!updated) {
        tally.raced += 1;
        console.log(`  RACE       ${label}  row changed after selection; left untouched`);
        continue;
      }
      tally[action] += 1;
      console.log(`  ${action === "failed" ? "FAILED" : "RECOVERED"}  ${label}`);
    } catch (error) {
      tally.errored += 1;
      console.error(`  ERROR      ${label}  ${String(error?.message || error).slice(0, 160)}`);
    }
  }

  console.log(JSON.stringify(tally));
  if (tally.errored) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exitCode = 1;
});
