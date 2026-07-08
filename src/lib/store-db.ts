import { eq, desc } from "drizzle-orm";
import { db } from "./db";
import { generations } from "./schema";
import type { GenerationItem } from "./types";

/**
 * Generation persistence — Postgres `generations` table (was history.json).
 * This table doubles as the generation log for the admin dashboard.
 */

type Row = typeof generations.$inferSelect;

function rowToItem(r: Row): GenerationItem {
  return {
    id: r.id,
    kind: r.kind as GenerationItem["kind"],
    status: r.status as GenerationItem["status"],
    prompt: r.prompt,
    model: r.model,
    aspectRatio: r.aspectRatio,
    resolution: r.resolution ?? undefined,
    duration: r.duration ?? undefined,
    url: r.url ?? undefined,
    poster: r.poster ?? undefined,
    referenceImages: r.referenceImages ?? undefined,
    error: r.error ?? undefined,
    moderationBlocked: r.moderationBlocked ?? undefined,
    taskId: r.taskId ?? undefined,
    projectId: r.projectId ?? undefined,
    folderId: r.folderId ?? undefined,
    userId: r.userId ?? undefined,
    costCents: r.costCents ?? undefined,
    isFavorite: r.isFavorite,
    favoritedAt: r.favoritedAt ?? undefined,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function itemToValues(item: GenerationItem): typeof generations.$inferInsert {
  return {
    id: item.id,
    kind: item.kind,
    status: item.status,
    prompt: item.prompt,
    model: item.model,
    aspectRatio: item.aspectRatio,
    resolution: item.resolution ?? null,
    duration: item.duration ?? null,
    url: item.url ?? null,
    poster: item.poster ?? null,
    error: item.error ?? null,
    moderationBlocked: item.moderationBlocked ?? null,
    referenceImages: item.referenceImages ?? null,
    projectId: item.projectId ?? null,
    folderId: item.folderId ?? null,
    userId: item.userId ?? null,
    costCents: item.costCents ?? 0,
    isFavorite: item.isFavorite ?? false,
    favoritedAt: item.favoritedAt ?? null,
    taskId: item.taskId ?? null,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

export async function readHistory(): Promise<GenerationItem[]> {
  const rows = await db
    .select()
    .from(generations)
    .orderBy(desc(generations.createdAt));
  return rows.map(rowToItem);
}

export async function upsertItem(item: GenerationItem): Promise<void> {
  const values = itemToValues(item);
  await db
    .insert(generations)
    .values(values)
    .onConflictDoUpdate({ target: generations.id, set: values });
}

export async function getItem(id: string): Promise<GenerationItem | undefined> {
  const rows = await db
    .select()
    .from(generations)
    .where(eq(generations.id, id))
    .limit(1);
  return rows[0] ? rowToItem(rows[0]) : undefined;
}

export async function deleteItem(id: string): Promise<void> {
  await db.delete(generations).where(eq(generations.id, id));
}

/** Move one item into a folder (or unsort it with folderId = undefined). */
export async function setItemFolder(
  id: string,
  projectId: string | undefined,
  folderId: string | undefined
): Promise<GenerationItem | undefined> {
  const rows = await db
    .update(generations)
    .set({
      projectId: projectId ?? null,
      folderId: folderId ?? null,
      updatedAt: Date.now(),
    })
    .where(eq(generations.id, id))
    .returning();
  return rows[0] ? rowToItem(rows[0]) : undefined;
}

/** Star/unstar a generation for the shared Favourites view. */
export async function setItemFavorite(
  id: string,
  isFavorite: boolean
): Promise<GenerationItem | undefined> {
  const rows = await db
    .update(generations)
    .set({
      isFavorite,
      favoritedAt: isFavorite ? Date.now() : null,
      updatedAt: Date.now(),
    })
    .where(eq(generations.id, id))
    .returning();
  return rows[0] ? rowToItem(rows[0]) : undefined;
}

/** Unsort every item in a folder (used when a folder is deleted). */
export async function clearFolderRefs(folderId: string): Promise<void> {
  await db
    .update(generations)
    .set({ folderId: null })
    .where(eq(generations.folderId, folderId));
}

/** Orphan every item in a project back to global history (project deleted). */
export async function clearProjectRefs(projectId: string): Promise<void> {
  await db
    .update(generations)
    .set({ projectId: null, folderId: null })
    .where(eq(generations.projectId, projectId));
}
