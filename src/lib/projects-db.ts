import { eq, asc, sql } from "drizzle-orm";
import { db } from "./db";
import { projects, folders } from "./schema";
import { clearProjectRefs, clearFolderRefs } from "./store-db";
import type { Project } from "./types";

/** Project + folder persistence — Postgres (was projects.json). */

export async function readProjects(): Promise<Project[]> {
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

export async function getProject(id: string): Promise<Project | undefined> {
  return (await readProjects()).find((p) => p.id === id);
}

/**
 * Guarantee at least one project exists, atomically (advisory lock) so
 * concurrent callers can't each create a duplicate default.
 */
export async function ensureDefaultProject(): Promise<Project[]> {
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
  name: string,
  createdBy?: string
): Promise<{ projects: Project[]; project: Project }> {
  const now = Date.now();
  const [row] = await db
    .insert(projects)
    .values({ name, createdBy: createdBy ?? null, createdAt: now, updatedAt: now })
    .returning();
  const project: Project = {
    id: row.id,
    name: row.name,
    brief: undefined,
    folders: [],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
  return { projects: await readProjects(), project };
}

export async function renameProject(id: string, name: string): Promise<Project[]> {
  await db
    .update(projects)
    .set({ name, updatedAt: Date.now() })
    .where(eq(projects.id, id));
  return readProjects();
}

export async function setBrief(id: string, brief: string): Promise<Project[]> {
  await db
    .update(projects)
    .set({ brief, updatedAt: Date.now() })
    .where(eq(projects.id, id));
  return readProjects();
}

export async function deleteProject(id: string): Promise<Project[]> {
  await db.delete(folders).where(eq(folders.projectId, id));
  await db.delete(projects).where(eq(projects.id, id));
  await clearProjectRefs(id);
  return readProjects();
}

export async function createFolder(
  projectId: string,
  name: string
): Promise<{ projects: Project[]; folder: { id: string; name: string; createdAt: number } }> {
  const now = Date.now();
  const [row] = await db
    .insert(folders)
    .values({ projectId, name, createdAt: now })
    .returning();
  await db.update(projects).set({ updatedAt: now }).where(eq(projects.id, projectId));
  return {
    projects: await readProjects(),
    folder: { id: row.id, name: row.name, createdAt: row.createdAt },
  };
}

export async function renameFolder(
  _projectId: string,
  folderId: string,
  name: string
): Promise<Project[]> {
  await db.update(folders).set({ name }).where(eq(folders.id, folderId));
  return readProjects();
}

export async function deleteFolder(
  _projectId: string,
  folderId: string
): Promise<Project[]> {
  await db.delete(folders).where(eq(folders.id, folderId));
  await clearFolderRefs(folderId);
  return readProjects();
}
