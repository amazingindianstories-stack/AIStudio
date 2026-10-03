import { eq, and, isNull, inArray, sql, asc } from "drizzle-orm";
import { getDb } from "./db.js";
import { folders, projects, generations, organizationIdempotencyKeys } from "./schema.js";
import { validateAndNormalizeFolderName } from "./folder-normalization.js";
import { logActivity } from "./activity.js";

export function getMaxNestingDepth() {
  const envVal = Number(process.env.MAX_NESTING_DEPTH);
  return Number.isInteger(envVal) && envVal > 0 ? envVal : 20;
}
export function getMaxSubtreeFolders() {
  const envVal = Number(process.env.MAX_SUBTREE_FOLDERS);
  return Number.isInteger(envVal) && envVal > 0 ? envVal : 500;
}
export function getMaxGenerationBatch() {
  const envVal = Number(process.env.MAX_GENERATION_BATCH);
  return Number.isInteger(envVal) && envVal > 0 ? envVal : 1000;
}
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export const MAX_NESTING_DEPTH = 20;
export const MAX_SUBTREE_FOLDERS = 500;
export const MAX_GENERATION_BATCH = 1000;

export function getScopeKey(projectId) {
  return projectId ? `project:${projectId}` : "global";
}

/**
 * Deterministically locks scopes in sorted order using transaction-level advisory locks.
 * Guarantees that concurrent structural mutations across the same or related scopes
 * execute serially and cannot form cycles or race conditions.
 */
export async function acquireScopeLocks(tx, ...scopeKeys) {
  const uniqueSorted = Array.from(new Set(scopeKeys.filter(Boolean))).sort();
  for (const key of uniqueSorted) {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${key}))`);
  }
}

/**
 * Calculates the height of a subtree (number of levels from root down to deepest descendant).
 * Root alone has height 1.
 */
export function computeSubtreeHeight(rootId, descendants) {
  if (!descendants || descendants.length === 0) return 1;
  const depthMap = new Map();
  depthMap.set(rootId, 1);
  let maxHeight = 1;
  for (const d of descendants) {
    const parentDepth = depthMap.get(d.parentId) || 1;
    const currentDepth = parentDepth + 1;
    depthMap.set(d.id, currentDepth);
    if (currentDepth > maxHeight) {
      maxHeight = currentDepth;
    }
  }
  return maxHeight;
}

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
  const maxDepth = getMaxNestingDepth();

  while (currentId) {
    if (visited.has(currentId)) {
      throw new OrganizationError("CYCLE_DETECTED", "Cycle detected in folder hierarchy.", 409);
    }
    visited.add(currentId);
    ancestorIds.push(currentId);
    depth += 1;

    if (depth > maxDepth) {
      throw new OrganizationError("EXCEEDS_MAX_DEPTH", `Folder nesting exceeds maximum depth of ${maxDepth}.`, 400);
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
  const maxSubtree = getMaxSubtreeFolders();

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

      if (result.length > maxSubtree) {
        throw new OrganizationError("SUBTREE_TOO_LARGE", `Subtree exceeds limit of ${maxSubtree} folders.`, 400);
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
  idempotencyKey = null,
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

      resolvedProjectId = parent.projectId ?? null;
    }

    // Deterministic scope locking
    const scopeKey = getScopeKey(resolvedProjectId);
    await acquireScopeLocks(tx, scopeKey);

    if (idempotencyKey) {
      const [existingKey] = await tx
        .select()
        .from(organizationIdempotencyKeys)
        .where(eq(organizationIdempotencyKeys.key, idempotencyKey))
        .limit(1);
      if (existingKey && Date.now() - existingKey.createdAt < IDEMPOTENCY_TTL_MS) {
        return existingKey.result;
      }
    }

    if (resolvedParentId) {
      // Check depth limit
      const { depth } = await computeAncestry(tx, resolvedParentId);
      const maxDepth = getMaxNestingDepth();
      if (depth >= maxDepth) {
        throw new OrganizationError("EXCEEDS_MAX_DEPTH", `Cannot exceed maximum folder depth of ${maxDepth}.`, 400);
      }

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

    const result = {
      id: inserted.id,
      name: inserted.name,
      projectId: inserted.projectId,
      parentId: inserted.parentId,
      version: inserted.version,
      createdAt: inserted.createdAt,
      updatedAt: inserted.updatedAt,
    };

    if (idempotencyKey) {
      await tx
        .insert(organizationIdempotencyKeys)
        .values({
          key: idempotencyKey,
          result,
          createdAt: now,
        })
        .onConflictDoUpdate({
          target: organizationIdempotencyKeys.key,
          set: { result, createdAt: now },
        });
    }

    return result;
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
  idempotencyKey = null,
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
      .for("update")
      .limit(1);

    if (!folder) {
      throw new OrganizationError("FOLDER_NOT_FOUND", "Folder not found.", 404);
    }

    const scopeKey = getScopeKey(folder.projectId);
    await acquireScopeLocks(tx, scopeKey);

    if (idempotencyKey) {
      const [existingKey] = await tx
        .select()
        .from(organizationIdempotencyKeys)
        .where(eq(organizationIdempotencyKeys.key, idempotencyKey))
        .limit(1);
      if (existingKey && Date.now() - existingKey.createdAt < IDEMPOTENCY_TTL_MS) {
        return existingKey.result;
      }
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
    const updateConds = [eq(folders.id, folderId)];
    if (expectedVersion !== undefined) {
      updateConds.push(eq(folders.version, expectedVersion));
    }

    const [updated] = await tx
      .update(folders)
      .set({
        name: norm.displayName,
        nameNormalized: norm.normalizedName,
        version: sql`${folders.version} + 1`,
        updatedAt: now,
      })
      .where(and(...updateConds))
      .returning();

    if (!updated) {
      throw new OrganizationError("VERSION_CONFLICT", "Folder has been modified by another operation.", 409);
    }

    if (actorId) {
      await logActivity(actorId, "rename_folder", {
        folderId,
        oldName: folder.name,
        newName: norm.displayName,
      });
    }

    const result = {
      id: updated.id,
      name: updated.name,
      projectId: updated.projectId,
      parentId: updated.parentId,
      version: updated.version,
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt,
    };

    if (idempotencyKey) {
      await tx
        .insert(organizationIdempotencyKeys)
        .values({
          key: idempotencyKey,
          result,
          createdAt: now,
        })
        .onConflictDoUpdate({
          target: organizationIdempotencyKeys.key,
          set: { result, createdAt: now },
        });
    }

    return result;
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
  idempotencyKey = null,
}) {
  const dest = normalizeDestination(destination);
  const db = await getDb();

  return db.transaction(async (tx) => {
    // 1. Peek at source and destination to discover scopes for advisory lock ordering
    const [sourcePeek] = await tx
      .select({ projectId: folders.projectId })
      .from(folders)
      .where(eq(folders.id, folderId))
      .limit(1);

    if (!sourcePeek) {
      throw new OrganizationError("FOLDER_NOT_FOUND", "Folder not found.", 404);
    }

    let targetProjectIdPeek = null;
    if (dest.type === "folder") {
      const [targetPeek] = await tx
        .select({ projectId: folders.projectId })
        .from(folders)
        .where(eq(folders.id, dest.folderId))
        .limit(1);
      if (!targetPeek) {
        throw new OrganizationError("DESTINATION_NOT_FOUND", "Target destination folder not found.", 404);
      }
      targetProjectIdPeek = targetPeek.projectId ?? null;
    } else if (dest.type === "project_root") {
      targetProjectIdPeek = dest.projectId;
    }

    const sourceScope = getScopeKey(sourcePeek.projectId);
    const targetScope = getScopeKey(targetProjectIdPeek);

    // Acquire transaction-scoped advisory locks on affected scopes in deterministic sorted order
    await acquireScopeLocks(tx, sourceScope, targetScope);

    if (idempotencyKey) {
      const [existingKey] = await tx
        .select()
        .from(organizationIdempotencyKeys)
        .where(eq(organizationIdempotencyKeys.key, idempotencyKey))
        .limit(1);
      if (existingKey && Date.now() - existingKey.createdAt < IDEMPOTENCY_TTL_MS) {
        return existingKey.result;
      }
    }

    // 2. Lock rows FOR UPDATE in deterministic alphabetical order
    let source;
    let targetFolder = null;

    if (dest.type === "folder") {
      const targetFolderId = dest.folderId;
      if (targetFolderId === folderId) {
        throw new OrganizationError("CANNOT_MOVE_INTO_SELF", "Cannot move a folder into itself.", 400);
      }

      const rowIds = [folderId, targetFolderId].sort();
      const rows = await tx
        .select()
        .from(folders)
        .where(inArray(folders.id, rowIds))
        .orderBy(asc(folders.id))
        .for("update");

      source = rows.find((r) => r.id === folderId);
      targetFolder = rows.find((r) => r.id === targetFolderId);

      if (!source) {
        throw new OrganizationError("FOLDER_NOT_FOUND", "Folder not found.", 404);
      }
      if (!targetFolder) {
        throw new OrganizationError("DESTINATION_NOT_FOUND", "Target destination folder not found.", 404);
      }
    } else {
      const [srcRow] = await tx
        .select()
        .from(folders)
        .where(eq(folders.id, folderId))
        .for("update")
        .limit(1);

      if (!srcRow) {
        throw new OrganizationError("FOLDER_NOT_FOUND", "Folder not found.", 404);
      }
      source = srcRow;
    }

    if (expectedVersion !== undefined && source.version !== expectedVersion) {
      throw new OrganizationError("VERSION_CONFLICT", "Folder has been modified by another operation.", 409);
    }

    let targetParentId = null;
    let targetProjectId = null;
    let targetDepth = 0;

    if (dest.type === "folder") {
      const targetFolderId = dest.folderId;

      // Check if targetFolder is a descendant of source (cycle prevention)
      const { ancestorIds, depth } = await computeAncestry(tx, targetFolderId);
      if (ancestorIds.includes(folderId)) {
        throw new OrganizationError("CYCLE_DETECTED", "Cannot move a folder into one of its descendants.", 400);
      }

      targetParentId = targetFolder.id;
      targetProjectId = targetFolder.projectId ?? null;
      targetDepth = depth;

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

    // Enforce total depth limit: target depth + subtree height <= MAX_NESTING_DEPTH
    const subtreeHeight = computeSubtreeHeight(folderId, descendants);
    const maxDepth = getMaxNestingDepth();
    if (targetDepth + subtreeHeight > maxDepth) {
      throw new OrganizationError(
        "EXCEEDS_MAX_DEPTH",
        `Moving this folder subtree would exceed maximum depth of ${maxDepth}.`,
        400
      );
    }

    // Move source folder with atomic conditional predicate
    const updateConds = [eq(folders.id, folderId)];
    if (expectedVersion !== undefined) {
      updateConds.push(eq(folders.version, expectedVersion));
    }

    const [moved] = await tx
      .update(folders)
      .set({
        parentId: targetParentId,
        projectId: targetProjectId,
        version: sql`${folders.version} + 1`,
        updatedAt: now,
      })
      .where(and(...updateConds))
      .returning();

    if (!moved) {
      throw new OrganizationError("VERSION_CONFLICT", "Folder has been modified by another operation.", 409);
    }

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

    if (actorId) {
      await logActivity(actorId, "move_folder", {
        folderId,
        sourceParentId: source.parentId,
        sourceProjectId: source.projectId,
        targetParentId,
        targetProjectId,
      });
    }

    const result = {
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

    if (idempotencyKey) {
      await tx
        .insert(organizationIdempotencyKeys)
        .values({
          key: idempotencyKey,
          result,
          createdAt: now,
        })
        .onConflictDoUpdate({
          target: organizationIdempotencyKeys.key,
          set: { result, createdAt: now },
        });
    }

    return result;
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
  idempotencyKey = null,
}) {
  const db = await getDb();
  return db.transaction(async (tx) => {
    const [folder] = await tx
      .select()
      .from(folders)
      .where(eq(folders.id, folderId))
      .for("update")
      .limit(1);

    if (!folder) {
      throw new OrganizationError("FOLDER_NOT_FOUND", "Folder not found.", 404);
    }

    const scopeKey = getScopeKey(folder.projectId);
    await acquireScopeLocks(tx, scopeKey);

    if (idempotencyKey) {
      const [existingKey] = await tx
        .select()
        .from(organizationIdempotencyKeys)
        .where(eq(organizationIdempotencyKeys.key, idempotencyKey))
        .limit(1);
      if (existingKey && Date.now() - existingKey.createdAt < IDEMPOTENCY_TTL_MS) {
        return existingKey.result;
      }
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

    const result = { success: true, deletedFolderId: folderId };

    if (idempotencyKey) {
      const now = Date.now();
      await tx
        .insert(organizationIdempotencyKeys)
        .values({
          key: idempotencyKey,
          result,
          createdAt: now,
        })
        .onConflictDoUpdate({
          target: organizationIdempotencyKeys.key,
          set: { result, createdAt: now },
        });
    }

    return result;
  });
}

/**
 * Moves one or more generations to a destination (folder, project unsorted, global unsorted).
 * Atomic multi-record operation inside a single transaction with deterministic locking.
 */
export async function moveGenerations({
  ids,
  destination,
  expectedVersions = undefined,
  actorId = null,
  idempotencyKey = null,
}) {
  if (!Array.isArray(ids) || ids.length === 0) {
    return { movedCount: 0, items: [] };
  }

  // Reject duplicate input IDs explicitly
  const idSet = new Set();
  for (const id of ids) {
    if (idSet.has(id)) {
      throw new OrganizationError(
        "DUPLICATE_GENERATION_IDS",
        `Duplicate generation ID detected in batch: ${id}`,
        400
      );
    }
    idSet.add(id);
  }

  const maxBatch = getMaxGenerationBatch();
  if (ids.length > maxBatch) {
    throw new OrganizationError("BATCH_TOO_LARGE", `Cannot move more than ${maxBatch} generations in a single batch.`, 400);
  }

  const dest = normalizeDestination(destination);
  const db = await getDb();

  return db.transaction(async (tx) => {
    if (idempotencyKey) {
      const [existingKey] = await tx
        .select()
        .from(organizationIdempotencyKeys)
        .where(eq(organizationIdempotencyKeys.key, idempotencyKey))
        .limit(1);
      if (existingKey && Date.now() - existingKey.createdAt < IDEMPOTENCY_TTL_MS) {
        return existingKey.result;
      }
    }

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
    const sortedIds = [...ids].sort();
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

    // Enforce optimistic concurrency per generation when expectedVersions is supplied
    if (expectedVersions) {
      for (const row of lockedRows) {
        const expVer = typeof expectedVersions === "object" ? expectedVersions[row.id] : undefined;
        if (expVer !== undefined && row.locationVersion !== expVer) {
          throw new OrganizationError(
            "VERSION_CONFLICT",
            `Generation ${row.id} has locationVersion ${row.locationVersion} but expected ${expVer}.`,
            409
          );
        }
      }
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
      .where(inArray(generations.id, sortedIds))
      .returning();

    if (actorId) {
      await logActivity(actorId, "move_generations", {
        count: ids.length,
        destinationType: dest.type,
        projectId: resolvedProjectId,
        folderId: resolvedFolderId,
      });
    }

    const result = {
      movedCount: updatedRows.length,
      projectId: resolvedProjectId,
      folderId: resolvedFolderId,
      updatedIds: updatedRows.map((r) => r.id),
    };

    if (idempotencyKey) {
      await tx
        .insert(organizationIdempotencyKeys)
        .values({
          key: idempotencyKey,
          result,
          createdAt: now,
        })
        .onConflictDoUpdate({
          target: organizationIdempotencyKeys.key,
          set: { result, createdAt: now },
        });
    }

    return result;
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
