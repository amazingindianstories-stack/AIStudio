import { config } from "dotenv";
import { sql } from "drizzle-orm";
import { getDb } from "../src/lib/db.js";

config({ path: process.env.ENV_FILE || ".env.local" });

/**
 * Read-only preflight auditor for generation naming migration.
 * Verifies legacy generation locations, naming tables readiness, and reports anomalies.
 */
export async function auditGenerationNaming(customDb = null) {
  const db = customDb || (await getDb());
  const report = {
    timestamp: new Date().toISOString(),
    totalGenerations: 0,
    folderAssignedCount: 0,
    projectUnsortedCount: 0,
    globalUnsortedCount: 0,
    assignedNamingCount: 0,
    unassignedNamingCount: 0,
    orphanedFolderGenerations: [],
    scopeMismatchedGenerations: [],
    namingTablesExist: false,
    duplicateSequences: [],
    counterDiscrepancies: [],
    issuesCount: 0,
  };

  // 1. Generations breakdown
  const genRes = await db.execute(sql`
    SELECT
      count(*)::int as total,
      count(*) FILTER (WHERE folder_id IS NOT NULL)::int as folder_assigned,
      count(*) FILTER (WHERE folder_id IS NULL AND project_id IS NOT NULL)::int as project_unsorted,
      count(*) FILTER (WHERE folder_id IS NULL AND project_id IS NULL)::int as global_unsorted
    FROM generations;
  `);
  const genRow = (genRes.rows ?? genRes)[0] || {};
  report.totalGenerations = Number(genRow.total || 0);
  report.folderAssignedCount = Number(genRow.folder_assigned || 0);
  report.projectUnsortedCount = Number(genRow.project_unsorted || 0);
  report.globalUnsortedCount = Number(genRow.global_unsorted || 0);

  // 2. Check for orphaned folder references
  const orphanFolderGens = await db.execute(sql`
    SELECT g.id, g.folder_id, g.project_id
    FROM generations g
    LEFT JOIN folders f ON g.folder_id = f.id
    WHERE g.folder_id IS NOT NULL AND f.id IS NULL
    LIMIT 50;
  `);
  report.orphanedFolderGenerations = orphanFolderGens.rows ?? orphanFolderGens;
  report.issuesCount += report.orphanedFolderGenerations.length;

  // 3. Check for folder-project scope mismatches
  const scopeMismatches = await db.execute(sql`
    SELECT g.id, g.folder_id, g.project_id as gen_project, f.project_id as folder_project
    FROM generations g
    JOIN folders f ON g.folder_id = f.id
    WHERE (g.project_id IS DISTINCT FROM f.project_id)
    LIMIT 50;
  `);
  report.scopeMismatchedGenerations = scopeMismatches.rows ?? scopeMismatches;
  report.issuesCount += report.scopeMismatchedGenerations.length;

  // 4. Check if generation_naming and naming_counters tables exist
  const tableCheck = await db.execute(sql`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = current_schema()
      AND table_name IN ('generation_naming', 'naming_counters');
  `);
  const liveTables = new Set((tableCheck.rows ?? tableCheck).map((r) => r.table_name));
  report.namingTablesExist = liveTables.has("generation_naming") && liveTables.has("naming_counters");

  if (liveTables.has("generation_naming")) {
    const assignedRes = await db.execute(sql`SELECT count(*)::int as count FROM generation_naming;`);
    report.assignedNamingCount = Number((assignedRes.rows ?? assignedRes)[0]?.count || 0);
    report.unassignedNamingCount = report.totalGenerations - report.assignedNamingCount;

    // Check for duplicate (namespace, sequence)
    const dupRes = await db.execute(sql`
      SELECT namespace, sequence, count(*)::int as count
      FROM generation_naming
      GROUP BY namespace, sequence
      HAVING count(*) > 1
      LIMIT 50;
    `);
    report.duplicateSequences = dupRes.rows ?? dupRes;
    report.issuesCount += report.duplicateSequences.length;

    // Check if any counters lag behind max sequence
    if (liveTables.has("naming_counters")) {
      const counterCheck = await db.execute(sql`
        SELECT gn.namespace, MAX(gn.sequence)::bigint as max_seq, nc.next_sequence
        FROM generation_naming gn
        LEFT JOIN naming_counters nc ON gn.namespace = nc.namespace
        GROUP BY gn.namespace, nc.next_sequence
        HAVING nc.next_sequence IS NULL OR nc.next_sequence <= MAX(gn.sequence);
      `);
      report.counterDiscrepancies = counterCheck.rows ?? counterCheck;
      report.issuesCount += report.counterDiscrepancies.length;
    }
  } else {
    report.unassignedNamingCount = report.totalGenerations;
  }

  return report;
}

if (process.argv[1] && process.argv[1].endsWith("audit-generation-naming.js")) {
  auditGenerationNaming()
    .then((report) => {
      console.log("=== Generation Naming Preflight Audit Report ===");
      console.log(`Timestamp: ${report.timestamp}`);
      console.log(`Total generations: ${report.totalGenerations}`);
      console.log(`  - Folder-assigned: ${report.folderAssignedCount}`);
      console.log(`  - Project unsorted: ${report.projectUnsortedCount}`);
      console.log(`  - Global unsorted: ${report.globalUnsortedCount}`);
      console.log(`Naming tables exist: ${report.namingTablesExist ? "YES" : "NO"}`);
      console.log(`Assigned naming: ${report.assignedNamingCount} / ${report.totalGenerations}`);
      console.log(`Unassigned naming: ${report.unassignedNamingCount}`);
      console.log(`Issues found: ${report.issuesCount}`);

      if (report.issuesCount > 0) {
        console.error("Audit detected blocking issues:");
        if (report.orphanedFolderGenerations.length) {
          console.error(`- ${report.orphanedFolderGenerations.length} generations reference non-existent folders`);
        }
        if (report.scopeMismatchedGenerations.length) {
          console.error(`- ${report.scopeMismatchedGenerations.length} generations have folder/project scope mismatches`);
        }
        if (report.duplicateSequences.length) {
          console.error(`- ${report.duplicateSequences.length} duplicate (namespace, sequence) entries in generation_naming`);
        }
        if (report.counterDiscrepancies.length) {
          console.error(`- ${report.counterDiscrepancies.length} namespace counters lagging behind max assigned sequence`);
        }
        process.exit(1);
      } else {
        console.log("Preflight audit passed with 0 blocking anomalies. Ready for migration.");
        process.exit(0);
      }
    })
    .catch((err) => {
      console.error("Audit failed with error:", err);
      process.exit(1);
    });
}
