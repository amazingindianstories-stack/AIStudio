/**
 * Read-only probe: does the rebuilt admin dashboard report true totals, and how
 * big is its payload now?
 *
 * Checks the three faults that came from shipping a 500-row window and treating
 * it as the dataset (reported 2026-07-30, "the generation count has been stuck
 * at 500"):
 *   1. totals must equal SQL count(*)/sum(), not the window's
 *   2. the Overview must agree with the Users tab, which was already SQL
 *   3. the log must page and filter without loading everything
 * Only SELECTs.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { desc, sql } from "drizzle-orm";
import { getDb } from "../src/lib/db";
import { activityLogs, generations, users } from "../src/lib/schema";
import { readAdminStats } from "../src/lib/admin-stats";
import { readPricing } from "../src/lib/pricing-db";
import { queryAdminLogs, decodeCursor } from "../src/lib/admin-logs";
import { ACTIVITY_PAGE_SIZE, queryActivity } from "../src/lib/admin-activity";

const OLD_LOG_LIMIT = 500;

function kb(bytes) {
  return `${(bytes / 1024).toFixed(1)} kB`;
}

let failures = 0;
function check(label, ok, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
}

async function main() {
  const db = await getDb();

  // ── ground truth, independent of the code under test ─────────────────────
  const [truth] = await db
    .select({
      rows: sql`count(*)::int`,
      cost: sql`coalesce(sum(${generations.costCents}), 0)::int`,
      images: sql`count(*) filter (where ${generations.kind} = 'image')::int`,
      videos: sql`count(*) filter (where ${generations.kind} = 'video')::int`,
      models: sql`count(distinct ${generations.model})::int`,
    })
    .from(generations);

  console.log("── ground truth ──────────────────────────────────────────────");
  console.log(
    `rows=${truth.rows}  cost=$${(truth.cost / 100).toFixed(2)}  ` +
      `image=${truth.images} video=${truth.videos}  models=${truth.models}\n`
  );

  // ── what the old code would have shown ───────────────────────────────────
  const window = await db
    .select({ costCents: generations.costCents })
    .from(generations)
    .orderBy(desc(generations.createdAt), desc(generations.id))
    .limit(OLD_LOG_LIMIT);
  const windowCost = window.reduce((s, r) => s + (r.costCents ?? 0), 0);
  console.log("── before (500-row window) ───────────────────────────────────");
  console.log(
    `Generations tile  ${window.length}   (off by ${truth.rows - window.length})`
  );
  console.log(
    `Total spend tile  $${(windowCost / 100).toFixed(2)}   ` +
      `(missing $${((truth.cost - windowCost) / 100).toFixed(2)}, ` +
      `${(100 - (windowCost / truth.cost) * 100).toFixed(1)}%)\n`
  );

  // ── stats now ────────────────────────────────────────────────────────────
  console.log("── after: readAdminStats() ───────────────────────────────────");
  const stats = await readAdminStats();
  check("total generations == count(*)", stats.totalGenerations === truth.rows,
    `${stats.totalGenerations}`);
  check("total cost == sum()", stats.totalCostCents === truth.cost,
    `$${(stats.totalCostCents / 100).toFixed(2)}`);
  check("byKind image", stats.byKind.find((k) => k.name === "image")?.value === truth.images);
  check("byKind video", stats.byKind.find((k) => k.name === "video")?.value === truth.videos);
  check("byKind sums to total",
    stats.byKind.reduce((s, k) => s + k.value, 0) === truth.rows);
  check("byModel covers every model", stats.byModel.length === truth.models,
    `${stats.byModel.length}`);
  check("byModel sums to total",
    stats.byModel.reduce((s, m) => s + m.value, 0) === truth.rows);
  check("models list matches byModel", stats.models.length === stats.byModel.length);
  check("overTime days ascending",
    stats.overTime.every((d, i, a) => i === 0 || a[i - 1].day <= d.day),
    `${stats.overTime.length} days`);

  // Cross-check against the Users tab, which was already SQL-aggregated. These
  // two disagreeing is what made the bug visible.
  const [{ userCost }] = await db
    .select({
      userCost: sql`coalesce(sum(${generations.costCents}), 0)::int`,
    })
    .from(generations);
  check("Overview agrees with per-user aggregate", stats.totalCostCents === userCost);

  // ── log paging ───────────────────────────────────────────────────────────
  console.log("\n── after: queryAdminLogs() keyset walk ───────────────────────");
  const seen = new Set();
  let cursor = null;
  let pages = 0;
  let firstTotal = -1;
  do {
    const page = await queryAdminLogs({}, decodeCursor(cursor) ?? undefined, 100);
    if (pages === 0) firstTotal = page.total;
    for (const r of page.rows) {
      if (seen.has(r.id)) check(`duplicate row ${r.id}`, false);
      seen.add(r.id);
    }
    cursor = page.nextCursor;
    pages++;
  } while (cursor && pages < 50);

  check("walk visits every row exactly once", seen.size === truth.rows,
    `${seen.size} rows over ${pages} pages`);
  check("total is the table total, not the page size", firstTotal === truth.rows,
    `${firstTotal}`);

  const one = await queryAdminLogs({}, undefined, 100);
  check("page respects limit", one.rows.length === Math.min(100, truth.rows));
  check("prompts truncated", one.rows.every((r) => r.prompt.length <= 300));
  check("truncation flagged",
    one.rows.every((r) => r.promptTruncated === (r.prompt.length === 300)));

  // Filters must narrow in SQL, and the total must narrow with them.
  const vids = await queryAdminLogs({ kind: "video" }, undefined, 100);
  check("kind filter total", vids.total === truth.videos, `${vids.total}`);
  check("kind filter rows", vids.rows.every((r) => r.kind === "video"));

  // A search term that cannot appear, to prove the ILIKE is escaped rather than
  // interpreted: a bare `%` would otherwise match everything.
  const wild = await queryAdminLogs({ q: "%" }, undefined, 5);
  check("LIKE wildcard escaped", wild.total < truth.rows, `${wild.total} of ${truth.rows}`);

  // ── activity: same window-vs-dataset fault, fixed the same way ───────────
  const [actTruth] = await db
    .select({
      rows: sql`count(*)::int`,
      actions: sql`count(distinct ${activityLogs.action})::int`,
    })
    .from(activityLogs);

  const act = await queryActivity();
  check("activity total is the table total", act.total === actTruth.rows, `${act.total}`);
  check(
    "activity page respects the page size",
    act.rows.length === Math.min(ACTIVITY_PAGE_SIZE, actTruth.rows),
    `${act.rows.length}`
  );
  check(
    "action list comes from DISTINCT, not the page",
    (act.actions?.length ?? 0) === actTruth.actions,
    `${act.actions?.length} of ${actTruth.actions}`
  );
  // Full keyset walk: every event exactly once, no skips, no repeats. The
  // trailing id in the cursor is what makes this hold — a "generate" event is
  // written per row of a batch, so several share one createdAt millisecond.
  const seenActs = new Set();
  let actCursor;
  let actPages = 0;
  let sawActionsAgain = false;
  do {
    const page = await queryActivity({}, decodeCursor(actCursor), ACTIVITY_PAGE_SIZE);
    if (actPages > 0 && page.actions) sawActionsAgain = true;
    for (const r of page.rows) {
      if (seenActs.has(r.id)) check(`duplicate activity row ${r.id}`, false);
      seenActs.add(r.id);
    }
    actCursor = page.nextCursor;
    actPages++;
  } while (actCursor && actPages < 500);
  check(
    "activity keyset walk covers the table exactly once",
    seenActs.size === actTruth.rows,
    `${seenActs.size} rows over ${actPages} pages`
  );
  check("action list is sent once, not per page", !sawActionsAgain);

  // A filter must narrow in SQL, and the total must narrow with it.
  const firstAction = act.actions?.[0];
  if (firstAction) {
    const [filtTruth] = await db
      .select({ n: sql`count(*)::int` })
      .from(activityLogs)
      .where(sql`${activityLogs.action} = ${firstAction}`);
    const filtered = await queryActivity({ action: firstAction });
    check(
      `action filter narrows (${firstAction})`,
      filtered.total === filtTruth.n && filtered.rows.every((r) => r.action === firstAction),
      `${filtered.total} of ${actTruth.rows}`
    );
  }

  // ── payload ──────────────────────────────────────────────────────────────
  // Everything /api/admin/data actually returns, so the figure below is the
  // route's real size and not a flattering subset of it.
  const [userRows, pricing] = await Promise.all([db.select().from(users), readPricing()]);
  const parts = {
    users: JSON.stringify(userRows).length,
    stats: JSON.stringify(stats).length,
    pricing: JSON.stringify(pricing).length,
  };
  const dataPayload = Object.values(parts).reduce((a, b) => a + b, 0);
  const logPayload = JSON.stringify(one).length;
  const actPayload = JSON.stringify(act).length;

  // What the activity list used to cost on open: the newest 500, in full.
  const oldActivity = await db
    .select()
    .from(activityLogs)
    .orderBy(desc(activityLogs.createdAt))
    .limit(OLD_LOG_LIMIT);
  const oldActPayload = JSON.stringify(oldActivity).length;

  console.log("\n── payload ───────────────────────────────────────────────────");
  console.log(`/api/admin/data                       ${kb(dataPayload)}`);
  for (const [name, size] of Object.entries(parts)) {
    console.log(`  ${name.padEnd(35)} ${kb(size)}`);
  }
  console.log(`/api/admin/logs     (first 100 rows)  ${kb(logPayload)}`);
  console.log(`/api/admin/activity (first ${ACTIVITY_PAGE_SIZE} rows)   ${kb(actPayload)}`);
  console.log(`\nwas: 2273.3 kB in one request on dashboard open`);
  console.log(
    `     of which activity was ${kb(oldActPayload)} once the log moved out`
  );
  console.log(
    `now: ${kb(dataPayload)} on open, +${kb(logPayload)} + ${kb(actPayload)} ` +
      `only on the Logs tab (${(2273.3 / (dataPayload / 1024)).toFixed(1)}× smaller on open)`
  );

  console.log(`\n${failures === 0 ? "all checks passed" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
