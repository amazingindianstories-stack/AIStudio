import { config } from "dotenv";
import { sql } from "drizzle-orm";
import { getDb } from "../src/lib/db.js";

config({ path: process.env.ENV_FILE || ".env.local" });

/**
 * Read-only preflight auditor for hierarchical folder migration (Phase 6.1).
 * Checks schema prerequisites and existing data anomalies without mutating anything.
 */
export async function auditFolderMigration(customDb = null) {
  const db = customDb || (await getDb());
  const report = {
    timestamp: new Date().toISOString(),
    projectsCount: 0,
    foldersCount: 0,
    generationsCount: 0,
    globalUnsortedCount: 0,
    projectUnsortedCount: 0,
    folderAssignedGenerationsCount: 0,
    orphanedFolderGenerations: [],
    orphanedProjectGenerations: [],
    orphanedProjectFolders: [],
    duplicateFolderNames: [],
    inconsistentGenerations: [],
    issuesCount: 0,
  };

  // 1. Projects count
  const projRes = await db.execute(sql`SELECT count(*)::int as count FROM projects;`);
  report.projectsCount = Number((projRes.rows ?? projRes)[0]?.count || 0);

  // 2. Folders count
  const foldRes = await db.execute(sql`SELECT count(*)::int as count FROM folders;`);
  report.foldersCount = Number((foldRes.rows ?? foldRes)[0]?.count || 0);

  // 3. Generations count
  const genRes = await db.execute(sql`SELECT count(*)::int as count FROM generations;`);
  report.generationsCount = Number((genRes.rows ?? genRes)[0]?.count || 0);

  // 4. Breakdown of generation organizational locations
  const locRes = await db.execute(sql`
    SELECT
      count(*) FILTER (WHERE project_id IS NULL AND folder_id IS NULL)::int as global_unsorted,
      count(*) FILTER (WHERE project_id IS NOT NULL AND folder_id IS NULL)::int as project_unsorted,
      count(*) FILTER (WHERE folder_id IS NOT NULL)::int as folder_assigned
    FROM generations;
  `);
  const locRow = (locRes.rows ?? locRes)[0] || {};
  report.globalUnsortedCount = Number(locRow.global_unsorted || 0);
  report.projectUnsortedCount = Number(locRow.project_unsorted || 0);
  report.folderAssignedGenerationsCount = Number(locRow.folder_assigned || 0);

  // 5. Orphaned folder references in generations
  const orphanFolderGens = await db.execute(sql`
    SELECT g.id, g.folder_id, g.project_id
    FROM generations g
    LEFT JOIN folders f ON g.folder_id = f.id
    WHERE g.folder_id IS NOT NULL AND f.id IS NULL
    LIMIT 50;
  `);
  report.orphanedFolderGenerations = (orphanFolderGens.rows ?? orphanFolderGens).map((r) => ({
    generationId: r.id,
    folderId: r.folder_id,
  }));
  report.issuesCount += report.orphanedFolderGenerations.length;

  // 6. Orphaned project references in generations
  const orphanProjGens = await db.execute(sql`
    SELECT g.id, g.project_id
    FROM generations g
    LEFT JOIN projects p ON g.project_id = p.id
    WHERE g.project_id IS NOT NULL AND p.id IS NULL
    LIMIT 50;
  `);
  report.orphanedProjectGenerations = (orphanProjGens.rows ?? orphanProjGens).map((r) => ({
    generationId: r.id,
    projectId: r.project_id,
  }));
  report.issuesCount += report.orphanedProjectGenerations.length;

  // 7. Orphaned project references in folders
  const orphanProjFolds = await db.execute(sql`
    SELECT f.id, f.name, f.project_id
    FROM folders f
    LEFT JOIN projects p ON f.project_id = p.id
    WHERE f.project_id IS NOT NULL AND p.id IS NULL
    LIMIT 50;
  `);
  report.orphanedProjectFolders = (orphanProjFolds.rows ?? orphanProjFolds).map((r) => ({
    folderId: r.id,
    folderName: r.name,
    projectId: r.project_id,
  }));
  report.issuesCount += report.orphanedProjectFolders.length;

  // 8. Sibling duplicate folder names (NFKC-normalized)
  const parentCol = await db.execute(sql`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'folders' AND column_name = 'parent_id';
  `);
  const hasParentCol = (parentCol.rows ?? parentCol).length > 0;

  let dupFolders;
  if (hasParentCol) {
    dupFolders = await db.execute(sql`
      SELECT project_id, parent_id, lower(trim(normalize(name, NFKC))) as norm_name, count(*)::int as count
      FROM folders
      GROUP BY project_id, parent_id, lower(trim(normalize(name, NFKC)))
      HAVING count(*) > 1;
    `);
  } else {
    dupFolders = await db.execute(sql`
      SELECT project_id, lower(trim(normalize(name, NFKC))) as norm_name, count(*)::int as count
      FROM folders
      GROUP BY project_id, lower(trim(normalize(name, NFKC)))
      HAVING count(*) > 1;
    `);
  }
  report.duplicateFolderNames = (dupFolders.rows ?? dupFolders).map((r) => ({
    projectId: r.project_id,
    parentId: r.parent_id ?? null,
    normalizedName: r.norm_name,
    count: Number(r.count),
  }));
  report.issuesCount += report.duplicateFolderNames.length;

  // 9. Inconsistent generations (folder exists, but generation.project_id != folder.project_id)
  const inconsistentGens = await db.execute(sql`
    SELECT g.id, g.project_id as gen_project_id, f.project_id as folder_project_id
    FROM generations g
    JOIN folders f ON g.folder_id = f.id
    WHERE (g.project_id IS DISTINCT FROM f.project_id)
    LIMIT 50;
  `);
  report.inconsistentGenerations = (inconsistentGens.rows ?? inconsistentGens).map((r) => ({
    generationId: r.id,
    generationProjectId: r.gen_project_id,
    folderProjectId: r.folder_project_id,
  }));
  report.issuesCount += report.inconsistentGenerations.length;

  // 10. If parent_id exists, check child/parent scope consistency and dangling parents
  if (hasParentCol) {
    const orphanParentFolds = await db.execute(sql`
      SELECT c.id, c.name, c.parent_id
      FROM folders c
      LEFT JOIN folders p ON c.parent_id = p.id
      WHERE c.parent_id IS NOT NULL AND p.id IS NULL
      LIMIT 50;
    `);
    const orphanParents = (orphanParentFolds.rows ?? orphanParentFolds).map((r) => ({
      folderId: r.id,
      folderName: r.name,
      parentId: r.parent_id,
    }));
    report.orphanedParentFolders = orphanParents;
    report.issuesCount += orphanParents.length;

    const inconsistentFolders = await db.execute(sql`
      SELECT c.id, c.name, c.project_id as child_proj, p.project_id as parent_proj
      FROM folders c
      JOIN folders p ON c.parent_id = p.id
      WHERE (c.project_id IS DISTINCT FROM p.project_id)
      LIMIT 50;
    `);
    const scopeInconsistentFolders = (inconsistentFolders.rows ?? inconsistentFolders).map((r) => ({
      folderId: r.id,
      folderName: r.name,
      childProjectId: r.child_proj,
      parentProjectId: r.parent_proj,
    }));
    report.inconsistentFolders = scopeInconsistentFolders;
    report.issuesCount += scopeInconsistentFolders.length;
  }

  return report;
}

async function main() {
  console.log("=== Veevee V1 — Hierarchical Folder Migration Preflight Audit ===");
  try {
    const report = await auditFolderMigration();
    console.log(`Audited at: ${report.timestamp}`);
    console.log(`- Projects: ${report.projectsCount}`);
    console.log(`- Folders: ${report.foldersCount}`);
    console.log(`- Generations: ${report.generationsCount}`);
    console.log(`  * Global Unsorted: ${report.globalUnsortedCount}`);
    console.log(`  * Project Unsorted: ${report.projectUnsortedCount}`);
    console.log(`  * Folder Assigned: ${report.folderAssignedGenerationsCount}`);
    console.log("\nIntegrity Assessment:");
    console.log(`- Orphaned folder references in generations: ${report.orphanedFolderGenerations.length}`);
    console.log(`- Orphaned project references in generations: ${report.orphanedProjectGenerations.length}`);
    console.log(`- Orphaned project references in folders: ${report.orphanedProjectFolders.length}`);
    console.log(`- Duplicate sibling folder names: ${report.duplicateFolderNames.length}`);
    console.log(`- Scope-inconsistent generations: ${report.inconsistentGenerations.length}`);

    if (report.issuesCount === 0) {
      console.log("\n[SUCCESS] Preflight audit passed: Database is clean and ready for additive migration.");
    } else {
      console.warn(`\n[WARNING] Found ${report.issuesCount} anomalies that require remediation before strict constraints.`);
    }
  } catch (error) {
    console.error("Preflight audit failed:", error);
    process.exitCode = 1;
  }
}

if (process.argv[1] && process.argv[1].endsWith("audit-folder-migration.js")) {
  main();
}
