import { config } from "dotenv";
import { sql } from "drizzle-orm";
import { getDb } from "../src/lib/db.js";

config({ path: process.env.ENV_FILE || ".env.local" });

/**
 * Strips sensitive tokens or signed query parameters from URLs or storage keys.
 */
function sanitizeMediaReference(urlOrKey) {
  if (!urlOrKey || typeof urlOrKey !== "string") return null;
  try {
    if (urlOrKey.startsWith("http://") || urlOrKey.startsWith("https://")) {
      const parsed = new URL(urlOrKey);
      // Remove all query params (e.g. Signature, Expires, Key-Pair-Id, token)
      return `${parsed.origin}${parsed.pathname}`;
    }
  } catch {
    // If not a standard URL, fall through to raw string
  }
  return urlOrKey.split("?")[0];
}

/**
 * Captures a deterministic, read-only organizational snapshot of projects, folders, and generations.
 * Supports both pre-migration (legacy flat) and post-migration (hierarchical) schemas.
 */
export async function snapshotOrganization(customDb = null) {
  const db = customDb || (await getDb());
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
    return captureOrganization(tx);
  });
}

async function captureOrganization(customDb) {
  const db = customDb || (await getDb());

  // 1. Check if folders has parent_id column in current search path / schema
  const parentColCheck = await db.execute(sql`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'folders'
      AND column_name = 'parent_id';
  `);
  const hasParentId = (parentColCheck.rows ?? parentColCheck).length > 0;

  // 2. Fetch Projects (ordered by id)
  const projectsRes = await db.execute(sql`
    SELECT id, name
    FROM projects
    ORDER BY id ASC;
  `);
  const projects = (projectsRes.rows ?? projectsRes).map((p) => ({
    id: String(p.id),
    name: String(p.name ?? ""),
  }));

  // 3. Fetch Folders (ordered by id)
  let foldersRes;
  if (hasParentId) {
    foldersRes = await db.execute(sql`
      SELECT id, project_id, parent_id, name
      FROM folders
      ORDER BY id ASC;
    `);
  } else {
    foldersRes = await db.execute(sql`
      SELECT id, project_id, NULL as parent_id, name
      FROM folders
      ORDER BY id ASC;
    `);
  }
  const folders = (foldersRes.rows ?? foldersRes).map((f) => ({
    id: String(f.id),
    projectId: f.project_id ? String(f.project_id) : null,
    parentId: f.parent_id ? String(f.parent_id) : null,
    name: String(f.name ?? ""),
  }));

  // 4. Fetch Generations (ordered by id)
  const gensRes = await db.execute(sql`
    SELECT id, project_id, folder_id, kind, url
    FROM generations
    ORDER BY id ASC;
  `);
  const generations = (gensRes.rows ?? gensRes).map((g) => {
    return {
      id: String(g.id),
      projectId: g.project_id ? String(g.project_id) : null,
      folderId: g.folder_id ? String(g.folder_id) : null,
      mediaRef: sanitizeMediaReference(g.url),
    };
  });

  // 5. Compute summary aggregations
  const generationsPerProject = {};
  const generationsPerFolder = {};
  const projectUnsortedCounts = {};
  let globalUnsortedCount = 0;

  for (const g of generations) {
    if (g.projectId) {
      generationsPerProject[g.projectId] = (generationsPerProject[g.projectId] || 0) + 1;
    }
    if (g.folderId) {
      generationsPerFolder[g.folderId] = (generationsPerFolder[g.folderId] || 0) + 1;
    }

    if (g.projectId && !g.folderId) {
      projectUnsortedCounts[g.projectId] = (projectUnsortedCounts[g.projectId] || 0) + 1;
    } else if (!g.projectId && !g.folderId) {
      globalUnsortedCount++;
    }
  }

  // Ensure all projects have an entry in projectUnsortedCounts
  for (const p of projects) {
    if (!(p.id in projectUnsortedCounts)) {
      projectUnsortedCounts[p.id] = 0;
    }
  }

  return {
    timestamp: new Date().toISOString(),
    counts: {
      totalProjects: projects.length,
      totalFolders: folders.length,
      totalGenerations: generations.length,
      globalUnsortedCount,
      generationsPerProject,
      generationsPerFolder,
      projectUnsortedCounts,
    },
    projects,
    folders,
    generations,
  };
}

/**
 * Compares two organizational snapshots (before and after migration)
 * to verify strict preservation invariants.
 */
export function compareOrganizationSnapshots(before, after) {
  for (const snapshot of [before, after]) {
    if (!snapshot || !["projects", "folders", "generations"].every((key) => {
      const rows = snapshot[key];
      return Array.isArray(rows) && rows.every((row) => row && typeof row.id === "string" && row.id &&
        (key === "projects" ? typeof row.name === "string" :
          (row.projectId === null || typeof row.projectId === "string") &&
          (key === "folders" ? typeof row.name === "string" && (row.parentId === null || typeof row.parentId === "string") :
            (row.folderId === null || typeof row.folderId === "string") && (row.mediaRef === null || typeof row.mediaRef === "string")))) &&
        new Set(rows.map((row) => row.id)).size === rows.length;
    })) return { isPreserved: false, differences: { invalidSnapshot: 1, details: ["Malformed snapshot or duplicate IDs."] } };
  }
  const beforeProjects = new Map(before.projects.map((p) => [p.id, p]));
  const afterProjects = new Map(after.projects.map((p) => [p.id, p]));

  const beforeFolders = new Map(before.folders.map((f) => [f.id, f]));
  const afterFolders = new Map(after.folders.map((f) => [f.id, f]));

  const beforeGens = new Map(before.generations.map((g) => [g.id, g]));
  const afterGens = new Map(after.generations.map((g) => [g.id, g]));

  const differences = {
    projectsAdded: 0,
    foldersAdded: 0,
    generationsAdded: 0,
    folderProjectAssignmentsChanged: 0,
    folderParentAssignmentsChanged: 0,
    projectsLost: 0,
    foldersLost: 0,
    generationsLost: 0,
    existingProjectIdsChanged: 0,
    existingProjectNamesChanged: 0,
    existingFolderIdsChanged: 0,
    existingFolderNamesChanged: 0,
    legacyFoldersWithNonNullParent: 0,
    existingGenerationIdsChanged: 0,
    generationProjectAssignmentsChanged: 0,
    generationFolderAssignmentsChanged: 0,
    projectUnsortedMembershipDifferences: 0,
    globalUnsortedMembershipDifferences: 0,
    mediaReferencesChanged: 0,
    details: [],
  };

  for (const [label, previous, current] of [
    ["projects", beforeProjects, afterProjects], ["folders", beforeFolders, afterFolders], ["generations", beforeGens, afterGens],
  ]) {
    for (const id of current.keys()) if (!previous.has(id)) {
      differences[`${label}Added`]++;
      differences.details.push(`Unexpected ${label} ID: ${id}`);
    }
  }

  // 1. Projects comparison
  for (const [id, bProj] of beforeProjects.entries()) {
    const aProj = afterProjects.get(id);
    if (!aProj) {
      differences.projectsLost++;
      differences.details.push(`Project lost: ${id} (${bProj.name})`);
    } else {
      if (aProj.name !== bProj.name) {
        differences.existingProjectNamesChanged++;
        differences.details.push(`Project name changed: ${id} from "${bProj.name}" to "${aProj.name}"`);
      }
    }
  }

  // 2. Folders comparison
  for (const [id, bFold] of beforeFolders.entries()) {
    const aFold = afterFolders.get(id);
    if (!aFold) {
      differences.foldersLost++;
      differences.details.push(`Folder lost: ${id} (${bFold.name})`);
    } else {
      if (aFold.name !== bFold.name) {
        differences.existingFolderNamesChanged++;
        differences.details.push(`Folder name changed: ${id} from "${bFold.name}" to "${aFold.name}"`);
      }
      if (aFold.projectId !== bFold.projectId) {
        differences.folderProjectAssignmentsChanged++;
        differences.details.push(`Folder projectId changed: ${id}`);
      }
      if (aFold.parentId !== bFold.parentId) {
        differences.folderParentAssignmentsChanged++;
        differences.details.push(`Folder parent changed: ${id}`);
      }
      // For legacy folders, parentId must be NULL
      if (aFold.parentId !== null && bFold.parentId === null) {
        differences.legacyFoldersWithNonNullParent++;
        differences.details.push(`Legacy folder acquired unexpected non-null parentId: ${id} -> ${aFold.parentId}`);
      }
    }
  }

  // 3. Generations comparison
  for (const [id, bGen] of beforeGens.entries()) {
    const aGen = afterGens.get(id);
    if (!aGen) {
      differences.generationsLost++;
      differences.details.push(`Generation lost: ${id}`);
    } else {
      if (aGen.projectId !== bGen.projectId) {
        differences.generationProjectAssignmentsChanged++;
        differences.details.push(`Gen ${id} project changed: ${bGen.projectId} -> ${aGen.projectId}`);
      }
      if (aGen.folderId !== bGen.folderId) {
        differences.generationFolderAssignmentsChanged++;
        differences.details.push(`Gen ${id} folder changed: ${bGen.folderId} -> ${aGen.folderId}`);
      }
      // Project unsorted check
      const bIsProjUnsorted = bGen.projectId && !bGen.folderId;
      const aIsProjUnsorted = aGen.projectId && !aGen.folderId;
      if (bIsProjUnsorted !== aIsProjUnsorted) {
        differences.projectUnsortedMembershipDifferences++;
        differences.details.push(`Gen ${id} project-unsorted changed: ${bIsProjUnsorted} -> ${aIsProjUnsorted}`);
      }
      // Global unsorted check
      const bIsGlobalUnsorted = !bGen.projectId && !bGen.folderId;
      const aIsGlobalUnsorted = !aGen.projectId && !aGen.folderId;
      if (bIsGlobalUnsorted !== aIsGlobalUnsorted) {
        differences.globalUnsortedMembershipDifferences++;
        differences.details.push(`Gen ${id} global-unsorted changed: ${bIsGlobalUnsorted} -> ${aIsGlobalUnsorted}`);
      }
      // Media reference check
      if (aGen.mediaRef !== bGen.mediaRef) {
        differences.mediaReferencesChanged++;
        differences.details.push(`Gen ${id} mediaRef changed: ${bGen.mediaRef} -> ${aGen.mediaRef}`);
      }
    }
  }

  const isPreserved = Object.entries(differences)
    .every(([key, value]) => key === "details" || value === 0);

  return {
    isPreserved,
    differences,
  };
}

async function main() {
  try {
    const snapshot = await snapshotOrganization();
    const outputIndex = process.argv.indexOf("--output");
    if (outputIndex !== -1) {
      const { writeFile } = await import("node:fs/promises");
      if (!process.argv[outputIndex + 1]) throw new Error("--output requires a path");
      await writeFile(process.argv[outputIndex + 1], JSON.stringify(snapshot, null, 2), { mode: 0o600, flag: "wx" });
    }
    console.log("=== Veevee V1 — Organization Snapshot ===");
    console.log(`Timestamp: ${snapshot.timestamp}`);
    console.log(`- Total Projects: ${snapshot.counts.totalProjects}`);
    console.log(`- Total Folders: ${snapshot.counts.totalFolders}`);
    console.log(`- Total Generations: ${snapshot.counts.totalGenerations}`);
    console.log(`  * Global Unsorted: ${snapshot.counts.globalUnsortedCount}`);
    console.log(`  * Project Unsorted Totals: ${JSON.stringify(snapshot.counts.projectUnsortedCounts)}`);
    console.log(`\nSnapshot captured cleanly (zero secrets exposed).`);
    if (process.env.SNAPSHOT_JSON === "1") {
      console.log(JSON.stringify(snapshot, null, 2));
    }
  } catch (err) {
    console.error("Failed to capture organization snapshot:", err);
    process.exitCode = 1;
  }
}

if (process.argv[1] && process.argv[1].endsWith("snapshot-organization.js")) {
  main();
}
