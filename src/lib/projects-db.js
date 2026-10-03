import { eq, asc, sql } from "drizzle-orm";
import { getDb } from "./db";
import { projects, folders, generations } from "./schema";
import {
  createFolder as engineCreateFolder,
  renameFolder as engineRenameFolder,
  deleteFolder as engineDeleteFolder,
} from "./folder-engine";
import { logActivity } from "./activity";

/** Project + folder persistence — Postgres (was projects.json). */

export async function readProjects() {
  const db = await getDb();
  const ps = await db.select().from(projects).orderBy(asc(projects.createdAt));
  const fs = await db.select().from(folders).orderBy(asc(folders.createdAt));
  return ps.map((p) => ({
    id: p.id,
    name: p.name,
    brief: p.brief ?? undefined,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    folders: fs
      .filter((f) => f.projectId === p.id)
      .map((f) => ({ id: f.id, name: f.name, createdAt: f.createdAt })),
  }));
}

export async function getProject(id) {
  return (await readProjects()).find((p) => p.id === id);
}

/**
 * Guarantee at least one project exists, atomically (advisory lock) so
 * concurrent callers can't each create a duplicate default.
 */
export async function ensureDefaultProject() {
  const db = await getDb();
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(815042)`);
    const existing = await tx.select({ id: projects.id }).from(projects).limit(1);
    if (existing.length === 0) {
      const now = Date.now();
      await tx
        .insert(projects)
        .values({ name: "My Project", createdAt: now, updatedAt: now });
    }
  });
  return readProjects();
}

export async function createProject(
  name,
  createdBy
) {
  const db = await getDb();
  const now = Date.now();
  const [row] = await db
    .insert(projects)
    .values({ name, createdBy: createdBy ?? null, createdAt: now, updatedAt: now })
    .returning();
  const project = {
    id: row.id,
    name: row.name,
    brief: undefined,
    folders: [],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
  return { projects: await readProjects(), project };
}

export async function renameProject(id, name) {
  const db = await getDb();
  await db
    .update(projects)
    .set({ name, updatedAt: Date.now() })
    .where(eq(projects.id, id));
  return readProjects();
}

export async function setBrief(id, brief) {
  const db = await getDb();
  await db
    .update(projects)
    .set({ brief, updatedAt: Date.now() })
    .where(eq(projects.id, id));
  return readProjects();
}

export async function deleteProject(id, actorId = null) {
  const db = await getDb();
  await db.transaction(async (tx) => {
    // 1. Acquire scope lock FIRST (unified lock ordering)
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'project:' + id}))`);

    // 2. Select project row FOR UPDATE SECOND
    const [project] = await tx
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, id))
      .for("update");

    if (!project) {
      const err = new Error("Project not found.");
      err.code = "PROJECT_NOT_FOUND";
      err.status = 404;
      throw err;
    }

    const [childFolder] = await tx
      .select({ id: folders.id })
      .from(folders)
      .where(eq(folders.projectId, id))
      .limit(1);

    if (childFolder) {
      const err = new Error("Cannot delete project: project contains folders. Remove or move folders first.");
      err.code = "PROJECT_NOT_EMPTY";
      err.status = 400;
      throw err;
    }

    const [childGen] = await tx
      .select({ id: generations.id })
      .from(generations)
      .where(eq(generations.projectId, id))
      .limit(1);

    if (childGen) {
      const err = new Error("Cannot delete project: project contains generations. Remove or move items first.");
      err.code = "PROJECT_NOT_EMPTY";
      err.status = 400;
      throw err;
    }

    await tx.delete(projects).where(eq(projects.id, id));

    if (actorId) {
      await logActivity(actorId, "delete_project", { projectId: id }, tx);
    }
  });
  return readProjects();
}

export async function createFolder(
  projectId,
  name
) {
  const folder = await engineCreateFolder({
    name,
    projectId: projectId || null,
    parentId: null,
  });
  return {
    projects: await readProjects(),
    folder: { id: folder.id, name: folder.name, createdAt: folder.createdAt },
  };
}

export async function renameFolder(
  projectId,
  folderId,
  name
) {
  await engineRenameFolder({
    folderId,
    projectId,
    name,
  });
  return readProjects();
}

export async function deleteFolder(
  projectId,
  folderId,
  actorId = null
) {
  await engineDeleteFolder({
    folderId,
    projectId,
    actorId,
  });
  return readProjects();
}
