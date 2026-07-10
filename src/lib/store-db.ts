import { eq, desc, lt } from "drizzle-orm";
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

export async function readHistory(
  cursor?: number,
  limitN = 20
): Promise<GenerationItem[]> {
  let query: any = db.select().from(generations);
  if (cursor) {
    query = query.where(lt(generations.createdAt, cursor));
  }
  const rows = await query.orderBy(desc(generations.createdAt)).limit(limitN);
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

// ---- QUEUE HELPERS ----

import { and, sql } from "drizzle-orm";

// Global active-request caps, per kind: images bound our own server (each
// running job is a 30–60s serverless invocation with best-of-N provider
// calls); videos bound the provider (concurrent remote renders + MCP rate
// limits). Anything beyond the cap waits in the queue.
const MAX_CONCURRENT: Record<string, number> = { image: 2, video: 2 };

export async function getQueuePosition(id: string): Promise<{ position: number; status: string } | null> {
  const item = await getItem(id);
  if (!item) return null;
  if (item.status !== "queued") return { position: 0, status: item.status };

  const cap = MAX_CONCURRENT[item.kind] ?? 2;

  // Count active running jobs of the same kind
  const runningCountRes = await db
    .select({ count: sql<number>`count(*)` })
    .from(generations)
    .where(and(eq(generations.status, "running"), eq(generations.kind, item.kind)));
  const running = Number(runningCountRes[0].count);

  // Count older queued jobs of the same kind
  const olderCountRes = await db
    .select({ count: sql<number>`count(*)` })
    .from(generations)
    .where(
      and(
        eq(generations.status, "queued"),
        eq(generations.kind, item.kind),
        lt(generations.createdAt, item.createdAt)
      )
    );
  const older = Number(olderCountRes[0].count);

  const totalAhead = running + older;
  const position = Math.max(0, totalAhead - (cap - 1));

  return { position, status: item.status };
}

export async function lockJob(id: string): Promise<boolean> {
  // Atomic update: only lock if still queued
  const res = await db
    .update(generations)
    .set({ status: "running", updatedAt: Date.now() })
    .where(and(eq(generations.id, id), eq(generations.status, "queued")))
    .returning({ id: generations.id });
  return res.length > 0;
}
