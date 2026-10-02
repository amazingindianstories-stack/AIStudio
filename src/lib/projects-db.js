import { eq, asc, sql } from "drizzle-orm";
import { getDb } from "./db";
import { projects, folders } from "./schema";
import { clearProjectRefs } from "./store-db";
import {
  createFolder as engineCreateFolder,
  renameFolder as engineRenameFolder,
  deleteFolder as engineDeleteFolder,
} from "./folder-engine";

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

export async function deleteProject(id) {
  const db = await getDb();
  await db.delete(folders).where(eq(folders.projectId, id));
  await db.delete(projects).where(eq(projects.id, id));
  await clearProjectRefs(id);
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
  folderId
) {
  await engineDeleteFolder({
    folderId,
    projectId,
  });
  return readProjects();
}
