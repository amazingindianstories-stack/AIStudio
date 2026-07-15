import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { getDb } from "./db";
import { canvasBoards } from "./schema";
import { emptyCanvasState } from "./canvas/serialization";
import type { CanvasBoard, CanvasBoardMeta, CanvasState } from "./canvas/types";

/**
 * Canvas board persistence — Postgres `canvas_boards` table (D-Persist:
 * whole graph in `data jsonb`, app-supplied `crypto.randomUUID()` id so the
 * client can route autosave PUTs immediately after create).
 */

type Row = typeof canvasBoards.$inferSelect;

function rowToMeta(r: Pick<Row, "id" | "projectId" | "name" | "createdBy" | "createdAt" | "updatedAt">): CanvasBoardMeta {
  return {
    id: r.id,
    projectId: r.projectId,
    name: r.name,
    createdBy: r.createdBy ?? null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

/** Metadata only (omits `data`) — keeps the board switcher light. */
export async function listBoards(projectId: string): Promise<CanvasBoardMeta[]> {
  const db = await getDb();
  const rows = await db
    .select({
      id: canvasBoards.id,
      projectId: canvasBoards.projectId,
      name: canvasBoards.name,
      createdBy: canvasBoards.createdBy,
      createdAt: canvasBoards.createdAt,
      updatedAt: canvasBoards.updatedAt,
    })
    .from(canvasBoards)
    .where(eq(canvasBoards.projectId, projectId));
  return rows.map(rowToMeta);
}

export async function getBoard(id: string): Promise<CanvasBoard | undefined> {
  const db = await getDb();
  const rows = await db.select().from(canvasBoards).where(eq(canvasBoards.id, id)).limit(1);
  const row = rows[0];
  if (!row) return undefined;
  return { ...rowToMeta(row), data: row.data };
}

export async function createBoard(
  projectId: string,
  name: string,
  createdBy: string | null
): Promise<CanvasBoardMeta> {
  const db = await getDb();
  const now = Date.now();
  const [row] = await db
    .insert(canvasBoards)
    .values({
      id: randomUUID(),
      projectId,
      name,
      data: emptyCanvasState(),
      createdBy: createdBy ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return rowToMeta(row);
}

export async function renameBoard(id: string, name: string): Promise<void> {
  const db = await getDb();
  await db
    .update(canvasBoards)
    .set({ name, updatedAt: Date.now() })
    .where(eq(canvasBoards.id, id));
}

export async function deleteBoard(id: string): Promise<void> {
  const db = await getDb();
  await db.delete(canvasBoards).where(eq(canvasBoards.id, id));
}

/** Autosave: overwrites the graph blob and bumps updatedAt. Returns
 * `undefined` (rather than falsely reporting success) if the board doesn't
 * exist — e.g. deleted from another tab while this one kept autosaving. */
export async function saveBoardData(
  id: string,
  data: CanvasState
): Promise<{ updatedAt: number } | undefined> {
  const db = await getDb();
  const updatedAt = Date.now();
  const rows = await db
    .update(canvasBoards)
    .set({ data, updatedAt })
    .where(eq(canvasBoards.id, id))
    .returning({ id: canvasBoards.id });
  if (!rows.length) return undefined;
  return { updatedAt };
}
