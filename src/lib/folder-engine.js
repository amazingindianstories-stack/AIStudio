import { eq, and, isNull, inArray, sql, asc } from "drizzle-orm";
import { getDb } from "./db.js";
import { folders, projects, generations } from "./schema.js";
import { validateAndNormalizeFolderName } from "./folder-normalization.js";
import { logActivity } from "./activity.js";

export const MAX_NESTING_DEPTH = 20;
export const MAX_SUBTREE_FOLDERS = 500;
export const MAX_GENERATION_BATCH = 1000;

export class OrganizationError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {number} [status=400]
   */
  constructor(code, message, status = 400) {
    super(message);
    this.name = "OrganizationError";
    this.code = code;
    this.status = status;
  }
}

/**
 * Normalizes destination descriptor into explicit canonical form.
 * Destination types:
 * - 'global_root': Root of the global library
 * - 'global_unsorted': Virtual global unsorted
 * - 'project_root': Root of a project (requires projectId)
 * - 'project_unsorted': Virtual project unsorted (requires projectId)
 * - 'folder': An ordinary folder (requires folderId)
 */
export function normalizeDestination(dest) {
  if (!dest || typeof dest !== "object") {
    throw new OrganizationError("INVALID_DESTINATION", "Destination descriptor must be an object.");
  }
  const type = dest.type;
  if (!["global_root", "global_unsorted", "project_root", "project_unsorted", "folder"].includes(type)) {
    throw new OrganizationError("INVALID_DESTINATION", `Unknown destination type: ${type}`);
  }
  if ((type === "project_root" || type === "project_unsorted") && !dest.projectId) {
    throw new OrganizationError("INVALID_DESTINATION", `Destination ${type} requires projectId.`);
  }
  if (type === "folder" && !dest.folderId) {
    throw new OrganizationError("INVALID_DESTINATION", "Destination folder requires folderId.");
  }
  return {
    type,
    projectId: dest.projectId ?? null,
    folderId: dest.folderId ?? null,
  };
}

/**
 * Computes depth of a folder by iteratively walking up its parents.
 * Detects cycles during traversal.
 * @param {any} tx
 * @param {string} folderId
 * @returns {Promise<{ depth: number, ancestorIds: string[], rootProjectId: string | null }>}
 */
async function computeAncestry(tx, folderId) {
  let currentId = folderId;
  const ancestorIds = [];
  const visited = new Set();
  let depth = 0;
  let rootProjectId = null;

  while (currentId) {
    if (visited.has(currentId)) {
      throw new OrganizationError("CYCLE_DETECTED", "Cycle detected in folder hierarchy.", 409);
    }
    visited.add(currentId);
    ancestorIds.push(currentId);
    depth += 1;

    if (depth > MAX_NESTING_DEPTH) {
      throw new OrganizationError("EXCEEDS_MAX_DEPTH", `Folder nesting exceeds maximum depth of ${MAX_NESTING_DEPTH}.`, 400);
    }

    const [row] = await tx
      .select({
        id: folders.id,
        parentId: folders.parentId,
        projectId: folders.projectId,
      })
      .from(folders)
      .where(eq(folders.id, currentId))
      .limit(1);

    if (!row) {
      throw new OrganizationError("FOLDER_NOT_FOUND", `Folder ${currentId} not found.`, 404);
    }

    rootProjectId = row.projectId ?? null;
    currentId = row.parentId;
  }

  return { depth, ancestorIds, rootProjectId };
}

/**
 * Finds all descendant folders of a folder using iterative traversal.
 * Enforces MAX_SUBTREE_FOLDERS safeguard.
 * @param {any} tx
 * @param {string} rootFolderId
 * @returns {Promise<Array<{ id: string, projectId: string | null, parentId: string | null, name: string }>>}
 */
async function getDescendants(tx, rootFolderId) {
  const result = [];
  const queue = [rootFolderId];
  const visited = new Set([rootFolderId]);

  while (queue.length > 0) {
    const parentId = queue.shift();
    const children = await tx
      .select({
        id: folders.id,
        projectId: folders.projectId,
        parentId: folders.parentId,
        name: folders.name,
      })
      .from(folders)
      .where(eq(folders.parentId, parentId));

    for (const child of children) {
      if (visited.has(child.id)) {
        throw new OrganizationError("CYCLE_DETECTED", "Cycle detected during subtree traversal.", 409);
      }
      visited.add(child.id);
      result.push(child);
      queue.push(child.id);

      if (result.length > MAX_SUBTREE_FOLDERS) {
        throw new OrganizationError("SUBTREE_TOO_LARGE", `Subtree exceeds limit of ${MAX_SUBTREE_FOLDERS} folders.`, 400);
      }
    }
  }

  return result;
}

/**
 * Creates a new folder (global root, project root, or subfolder).
 */
export async function createFolder({
  name,
  projectId = null,
  parentId = null,
  actorId = null,
}) {
  const norm = validateAndNormalizeFolderName(name);
  if (!norm.valid) {
    throw new OrganizationError("INVALID_NAME", norm.error, 400);
  }

  const db = await getDb();
  return db.transaction(async (tx) => {
    let resolvedProjectId = projectId ? String(projectId) : null;
    let resolvedParentId = parentId ? String(parentId) : null;

    if (resolvedParentId) {
      // Must inherit scope from parent folder
      const [parent] = await tx
        .select()
        .from(folders)
        .where(eq(folders.id, resolvedParentId))
        .limit(1);

      if (!parent) {
        throw new OrganizationError("FOLDER_NOT_FOUND", "Parent folder does not exist.", 404);
      }

      // Check depth limit
      const { depth } = await computeAncestry(tx, resolvedParentId);
      if (depth >= MAX_NESTING_DEPTH) {
        throw new OrganizationError("EXCEEDS_MAX_DEPTH", `Cannot exceed maximum folder depth of ${MAX_NESTING_DEPTH}.`, 400);
      }

      resolvedProjectId = parent.projectId ?? null;

      // Check sibling uniqueness under this parent
      const [existingSibling] = await tx
        .select({ id: folders.id })
        .from(folders)
        .where(
          and(
            eq(folders.parentId, resolvedParentId),
            eq(folders.nameNormalized, norm.normalizedName)
          )
        )
        .limit(1);

      if (existingSibling) {
        throw new OrganizationError("DUPLICATE_FOLDER_NAME", `A folder named "${norm.displayName}" already exists in this location.`, 409);
      }
    } else if (resolvedProjectId) {
      // Root folder in a project
      const [project] = await tx
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.id, resolvedProjectId))
        .limit(1);

      if (!project) {
        throw new OrganizationError("PROJECT_NOT_FOUND", "Specified project does not exist.", 404);
      }

      const [existingSibling] = await tx
        .select({ id: folders.id })
        .from(folders)
        .where(
          and(
            eq(folders.projectId, resolvedProjectId),
            isNull(folders.parentId),
            eq(folders.nameNormalized, norm.normalizedName)
          )
        )
        .limit(1);

      if (existingSibling) {
        throw new OrganizationError("DUPLICATE_FOLDER_NAME", `A root folder named "${norm.displayName}" already exists in this project.`, 409);
      }
    } else {
      // Global root folder
      const [existingSibling] = await tx
        .select({ id: folders.id })
        .from(folders)
        .where(
          and(
            isNull(folders.projectId),
            isNull(folders.parentId),
            eq(folders.nameNormalized, norm.normalizedName)
          )
        )
        .limit(1);

      if (existingSibling) {
        throw new OrganizationError("DUPLICATE_FOLDER_NAME", `A root folder named "${norm.displayName}" already exists in the Global Library.`, 409);
      }
    }

    const now = Date.now();
    const [inserted] = await tx
      .insert(folders)
      .values({
        name: norm.displayName,
        nameNormalized: norm.normalizedName,
        projectId: resolvedProjectId,
        parentId: resolvedParentId,
        version: 1,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    if (resolvedProjectId) {
      await tx
        .update(projects)
        .set({ updatedAt: now })
        .where(eq(projects.id, resolvedProjectId));
    }

    if (actorId) {
      await logActivity(actorId, "create_folder", {
        folderId: inserted.id,
        name: inserted.name,
        projectId: resolvedProjectId,
        parentId: resolvedParentId,
      });
    }

    return {
      id: inserted.id,
      name: inserted.name,
      projectId: inserted.projectId,
      parentId: inserted.parentId,
      version: inserted.version,
      createdAt: inserted.createdAt,
      updatedAt: inserted.updatedAt,
    };
  });
}

/**
 * Renames an existing folder with sibling uniqueness and optimistic concurrency.
 */
export async function renameFolder({
  folderId,
  projectId = undefined,
  name,
  expectedVersion = undefined,
  actorId = null,
}) {
  const norm = validateAndNormalizeFolderName(name);
  if (!norm.valid) {
    throw new OrganizationError("INVALID_NAME", norm.error, 400);
  }

  const db = await getDb();
  return db.transaction(async (tx) => {
    const [folder] = await tx
      .select()
      .from(folders)
      .where(eq(folders.id, folderId))
      .limit(1);

    if (!folder) {
      throw new OrganizationError("FOLDER_NOT_FOUND", "Folder not found.", 404);
    }

    if (projectId !== undefined) {
      const expectedProj = projectId ? String(projectId) : null;
      const actualProj = folder.projectId ? String(folder.projectId) : null;
      if (expectedProj !== actualProj) {
        throw new OrganizationError("PROJECT_MISMATCH", "Project mismatch: Folder does not belong to the specified project.", 403);
      }
    }

    if (expectedVersion !== undefined && folder.version !== expectedVersion) {
      throw new OrganizationError("VERSION_CONFLICT", "Folder has been modified by another operation.", 409);
    }

    // Check sibling uniqueness
    let siblingConflict;
    if (folder.parentId) {
      [siblingConflict] = await tx
        .select({ id: folders.id })
        .from(folders)
        .where(
          and(
            eq(folders.parentId, folder.parentId),
            eq(folders.nameNormalized, norm.normalizedName),
            sql`${folders.id} <> ${folderId}`
          )
        )
        .limit(1);
    } else if (folder.projectId) {
      [siblingConflict] = await tx
        .select({ id: folders.id })
        .from(folders)
        .where(
          and(
            eq(folders.projectId, folder.projectId),
            isNull(folders.parentId),
            eq(folders.nameNormalized, norm.normalizedName),
            sql`${folders.id} <> ${folderId}`
          )
        )
        .limit(1);
    } else {
      [siblingConflict] = await tx
        .select({ id: folders.id })
        .from(folders)
        .where(
          and(
            isNull(folders.projectId),
            isNull(folders.parentId),
            eq(folders.nameNormalized, norm.normalizedName),
            sql`${folders.id} <> ${folderId}`
          )
        )
        .limit(1);
    }

    if (siblingConflict) {
      throw new OrganizationError("DUPLICATE_FOLDER_NAME", `A folder named "${norm.displayName}" already exists in this location.`, 409);
    }

    const now = Date.now();
    const [updated] = await tx
      .update(folders)
      .set({
        name: norm.displayName,
        nameNormalized: norm.normalizedName,
        version: sql`${folders.version} + 1`,
        updatedAt: now,
      })
      .where(eq(folders.id, folderId))
      .returning();

    if (actorId) {
      await logActivity(actorId, "rename_folder", {
        folderId,
        oldName: folder.name,
        newName: norm.displayName,
      });
    }

    return {
      id: updated.id,
      name: updated.name,
      projectId: updated.projectId,
      parentId: updated.parentId,
      version: updated.version,
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt,
    };
  });
}

/**
 * Moves a folder (and its whole subtree) to a new parent folder or root scope.
 * Supports cross-scope moves (global <-> project, project1 <-> project2).
 * Reconciles contained folder scopes and all contained generation project IDs.
 */
export async function moveFolder({
  folderId,
  destination,
  expectedVersion = undefined,
  actorId = null,
}) {
  const dest = normalizeDestination(destination);
  const db = await getDb();

  return db.transaction(async (tx) => {
    // Lock source folder
    const [source] = await tx
      .select()
      .from(folders)
      .where(eq(folders.id, folderId))
      .limit(1);

    if (!source) {
      throw new OrganizationError("FOLDER_NOT_FOUND", "Folder not found.", 404);
    }

    if (expectedVersion !== undefined && source.version !== expectedVersion) {
      throw new OrganizationError("VERSION_CONFLICT", "Folder has been modified by another operation.", 409);
    }

    let targetParentId = null;
    let targetProjectId = null;

    if (dest.type === "folder") {
      const targetFolderId = dest.folderId;
      if (targetFolderId === folderId) {
        throw new OrganizationError("CANNOT_MOVE_INTO_SELF", "Cannot move a folder into itself.", 400);
      }

      // Check if targetFolder is a descendant of source (cycle prevention)
      const { ancestorIds, depth: targetDepth } = await computeAncestry(tx, targetFolderId);
      if (ancestorIds.includes(folderId)) {
        throw new OrganizationError("CYCLE_DETECTED", "Cannot move a folder into one of its descendants.", 400);
      }

      const [targetFolder] = await tx
        .select()
        .from(folders)
        .where(eq(folders.id, targetFolderId))
        .limit(1);

      if (!targetFolder) {
        throw new OrganizationError("DESTINATION_NOT_FOUND", "Target destination folder not found.", 404);
      }

      targetParentId = targetFolder.id;
      targetProjectId = targetFolder.projectId ?? null;

      // Check total depth: rough upper bound on new depth
      if (targetDepth + 1 > MAX_NESTING_DEPTH) {
        throw new OrganizationError("EXCEEDS_MAX_DEPTH", `Moving this folder would exceed maximum depth of ${MAX_NESTING_DEPTH}.`, 400);
      }

      // Sibling uniqueness check
      const [existingSibling] = await tx
        .select({ id: folders.id })
        .from(folders)
        .where(
          and(
            eq(folders.parentId, targetFolderId),
            eq(folders.nameNormalized, source.nameNormalized),
            sql`${folders.id} <> ${folderId}`
          )
        )
        .limit(1);

      if (existingSibling) {
        throw new OrganizationError("DUPLICATE_FOLDER_NAME", `A folder named "${source.name}" already exists in the destination.`, 409);
      }
    } else if (dest.type === "project_root") {
      targetParentId = null;
      targetProjectId = dest.projectId;

      const [proj] = await tx
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.id, targetProjectId))
        .limit(1);

      if (!proj) {
        throw new OrganizationError("PROJECT_NOT_FOUND", "Destination project does not exist.", 404);
      }

      const [existingSibling] = await tx
        .select({ id: folders.id })
        .from(folders)
        .where(
          and(
            eq(folders.projectId, targetProjectId),
            isNull(folders.parentId),
            eq(folders.nameNormalized, source.nameNormalized),
            sql`${folders.id} <> ${folderId}`
          )
        )
        .limit(1);

      if (existingSibling) {
        throw new OrganizationError("DUPLICATE_FOLDER_NAME", `A root folder named "${source.name}" already exists in the destination project.`, 409);
      }
    } else if (dest.type === "global_root") {
      targetParentId = null;
      targetProjectId = null;

      const [existingSibling] = await tx
        .select({ id: folders.id })
        .from(folders)
        .where(
          and(
            isNull(folders.projectId),
            isNull(folders.parentId),
            eq(folders.nameNormalized, source.nameNormalized),
            sql`${folders.id} <> ${folderId}`
          )
        )
        .limit(1);

      if (existingSibling) {
        throw new OrganizationError("DUPLICATE_FOLDER_NAME", `A root folder named "${source.name}" already exists in the Global Library.`, 409);
      }
    } else {
      throw new OrganizationError("INVALID_DESTINATION", `Cannot move folder to destination type: ${dest.type}`, 400);
    }

    const now = Date.now();
    const descendants = await getDescendants(tx, folderId);
    const allSubtreeFolderIds = [folderId, ...descendants.map((d) => d.id)];

    // Check if scope (projectId) changed
    const scopeChanged = (source.projectId ?? null) !== targetProjectId;

    if (scopeChanged) {
      // 1. Update all descendant folders to new projectId
      if (descendants.length > 0) {
        await tx
          .update(folders)
          .set({ projectId: targetProjectId, updatedAt: now })
          .where(inArray(folders.id, descendants.map((d) => d.id)));
      }

      // 2. Reconcile all generations in this subtree to new projectId
      await tx
        .update(generations)
        .set({
          projectId: targetProjectId,
          locationVersion: sql`${generations.locationVersion} + 1`,
          updatedAt: now,
        })
        .where(inArray(generations.folderId, allSubtreeFolderIds));
    }

    // Move source folder
    const [moved] = await tx
      .update(folders)
      .set({
        parentId: targetParentId,
        projectId: targetProjectId,
        version: sql`${folders.version} + 1`,
        updatedAt: now,
      })
      .where(eq(folders.id, folderId))
      .returning();

    if (actorId) {
      await logActivity(actorId, "move_folder", {
        folderId,
        sourceParentId: source.parentId,
        sourceProjectId: source.projectId,
        targetParentId,
        targetProjectId,
      });
    }

    return {
      folder: {
        id: moved.id,
        name: moved.name,
        projectId: moved.projectId,
        parentId: moved.parentId,
        version: moved.version,
        createdAt: moved.createdAt,
        updatedAt: moved.updatedAt,
      },
      subtreeFolderCount: allSubtreeFolderIds.length,
      scopeChanged,
    };
  });
}

/**
 * Deletes an empty folder (non-recursive).
 * Rejects if folder has child folders or generations.
 */
export async function deleteFolder({
  folderId,
  projectId = undefined,
  actorId = null,
}) {
  const db = await getDb();
  return db.transaction(async (tx) => {
    const [folder] = await tx
      .select()
      .from(folders)
      .where(eq(folders.id, folderId))
      .limit(1);

    if (!folder) {
      throw new OrganizationError("FOLDER_NOT_FOUND", "Folder not found.", 404);
    }

    if (projectId !== undefined) {
      const expectedProj = projectId ? String(projectId) : null;
      const actualProj = folder.projectId ? String(folder.projectId) : null;
      if (expectedProj !== actualProj) {
        throw new OrganizationError("PROJECT_MISMATCH", "Project mismatch: Folder does not belong to the specified project.", 403);
      }
    }

    // Check for child folders
    const [childFolder] = await tx
      .select({ id: folders.id })
      .from(folders)
      .where(eq(folders.parentId, folderId))
      .limit(1);

    if (childFolder) {
      throw new OrganizationError(
        "FOLDER_NOT_EMPTY",
        "Folder cannot be deleted because it contains subfolders. Remove or move subfolders first.",
        400
      );
    }

    // Check for generations directly in this folder
    const [childGen] = await tx
      .select({ id: generations.id })
      .from(generations)
      .where(eq(generations.folderId, folderId))
      .limit(1);

    if (childGen) {
      throw new OrganizationError(
        "FOLDER_NOT_EMPTY",
        "Folder cannot be deleted because it contains items. Move items out before deleting.",
        400
      );
    }

    await tx.delete(folders).where(eq(folders.id, folderId));

    if (actorId) {
      await logActivity(actorId, "delete_folder", {
        folderId,
        name: folder.name,
        projectId: folder.projectId,
      });
    }

    return { success: true, deletedFolderId: folderId };
  });
}

/**
 * Moves one or more generations to a destination (folder, project unsorted, global unsorted).
 * Atomic multi-record operation inside a single transaction with deterministic locking.
 */
export async function moveGenerations({
  ids,
  destination,
  actorId = null,
}) {
  if (!Array.isArray(ids) || ids.length === 0) {
    return { movedCount: 0, items: [] };
  }

  // Deduplicate IDs and preserve ordering
  const uniqueIds = Array.from(new Set(ids));

  if (uniqueIds.length > MAX_GENERATION_BATCH) {
    throw new OrganizationError("BATCH_TOO_LARGE", `Cannot move more than ${MAX_GENERATION_BATCH} generations in a single batch.`, 400);
  }

  const dest = normalizeDestination(destination);
  const db = await getDb();

  return db.transaction(async (tx) => {
    let resolvedProjectId = null;
    let resolvedFolderId = null;

    if (dest.type === "folder") {
      const [folder] = await tx
        .select()
        .from(folders)
        .where(eq(folders.id, dest.folderId))
        .limit(1);

      if (!folder) {
        throw new OrganizationError("DESTINATION_NOT_FOUND", "Destination folder does not exist.", 404);
      }

      resolvedFolderId = folder.id;
      // The folder authoritatively dictates the project assignment
      resolvedProjectId = folder.projectId ?? null;
    } else if (dest.type === "global_unsorted" || dest.type === "global_root") {
      resolvedFolderId = null;
      resolvedProjectId = null;
    } else if (dest.type === "project_unsorted" || dest.type === "project_root") {
      resolvedFolderId = null;
      resolvedProjectId = dest.projectId;

      const [project] = await tx
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.id, resolvedProjectId))
        .limit(1);

      if (!project) {
        throw new OrganizationError("PROJECT_NOT_FOUND", "Destination project does not exist.", 404);
      }
    } else {
      throw new OrganizationError("INVALID_DESTINATION", `Invalid generation destination type: ${dest.type}`, 400);
    }

    // Deterministic lock acquisition by sorting IDs alphabetically to prevent deadlocks
    const sortedIds = [...uniqueIds].sort();
    const lockedRows = await tx
      .select({
        id: generations.id,
        projectId: generations.projectId,
        folderId: generations.folderId,
        locationVersion: generations.locationVersion,
      })
      .from(generations)
      .where(inArray(generations.id, sortedIds))
      .orderBy(asc(generations.id))
      .for("update");

    if (lockedRows.length !== sortedIds.length) {
      const foundSet = new Set(lockedRows.map((r) => r.id));
      const missing = sortedIds.find((id) => !foundSet.has(id));
      throw new OrganizationError("GENERATION_NOT_FOUND", `Generation ${missing} not found.`, 404);
    }

    const now = Date.now();
    const updatedRows = await tx
      .update(generations)
      .set({
        projectId: resolvedProjectId,
        folderId: resolvedFolderId,
        locationVersion: sql`${generations.locationVersion} + 1`,
        updatedAt: now,
      })
      .where(inArray(generations.id, uniqueIds))
      .returning();

    if (actorId) {
      await logActivity(actorId, "move_generations", {
        count: uniqueIds.length,
        destinationType: dest.type,
        projectId: resolvedProjectId,
        folderId: resolvedFolderId,
      });
    }

    return {
      movedCount: updatedRows.length,
      projectId: resolvedProjectId,
      folderId: resolvedFolderId,
      updatedIds: updatedRows.map((r) => r.id),
    };
  });
}

/**
 * Retrieves folder ancestry (breadcrumbs) from root to the given folder.
 */
export async function getFolderAncestry(folderId) {
  const db = await getDb();
  let currentId = folderId;
  const breadcrumbs = [];
  const visited = new Set();

  while (currentId) {
    if (visited.has(currentId)) break;
    visited.add(currentId);

    const [folder] = await db
      .select({
        id: folders.id,
        name: folders.name,
        projectId: folders.projectId,
        parentId: folders.parentId,
      })
      .from(folders)
      .where(eq(folders.id, currentId))
      .limit(1);

    if (!folder) break;
    breadcrumbs.unshift({
      id: folder.id,
      name: folder.name,
      projectId: folder.projectId,
      parentId: folder.parentId,
    });
    currentId = folder.parentId;
  }

  return breadcrumbs;
}

/**
 * Retrieves immediate child folders and counts for a given location.
 */
export async function getFolderChildren({ projectId = null, parentId = null } = {}) {
  const db = await getDb();
  const conds = [];

  if (parentId) {
    conds.push(eq(folders.parentId, parentId));
  } else {
    conds.push(isNull(folders.parentId));
    if (projectId) {
      conds.push(eq(folders.projectId, projectId));
    } else {
      conds.push(isNull(folders.projectId));
    }
  }

  return db
    .select()
    .from(folders)
    .where(and(...conds))
    .orderBy(asc(folders.name));
}

/**
 * Retrieves the complete folder tree for the library, grouped by global folders and projects.
 */
export async function getLibraryTree() {
  const db = await getDb();
  const allFolders = await db
    .select()
    .from(folders)
    .orderBy(asc(folders.name));

  const allProjects = await db
    .select()
    .from(projects)
    .orderBy(asc(projects.name));

  // Build tree index by parentId
  const byParent = new Map();
  for (const f of allFolders) {
    const pKey = f.parentId || (f.projectId ? `proj:${f.projectId}` : "global:root");
    if (!byParent.has(pKey)) byParent.set(pKey, []);
    byParent.get(pKey).push(f);
  }

  function buildTree(pKey) {
    const children = byParent.get(pKey) || [];
    return children.map((c) => ({
      id: c.id,
      name: c.name,
      projectId: c.projectId,
      parentId: c.parentId,
      version: c.version,
      children: buildTree(c.id),
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    }));
  }

  const globalTree = buildTree("global:root");
  const projectTrees = allProjects.map((p) => ({
    id: p.id,
    name: p.name,
    brief: p.brief,
    folders: buildTree(`proj:${p.id}`),
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  }));

  return {
    globalFolders: globalTree,
    projects: projectTrees,
  };
}
