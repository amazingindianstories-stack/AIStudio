import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { getDb } from "./db";
import { canvasBoards } from "./schema";
import { emptyCanvasState } from "./canvas/serialization";

/**
 * Canvas board persistence — Postgres `canvas_boards` table (D-Persist:
 * whole graph in `data jsonb`, app-supplied `crypto.randomUUID()` id so the
 * client can route autosave PUTs immediately after create).
 */

function rowToMeta(r) {
  return {
    id: r.id,
    projectId: r.projectId,
    name: r.name,
    createdBy: r.createdBy ?? null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

/** Postgres compares `uuid` columns by casting the operand, so a non-uuid
 *  string raises rather than returning no rows. Every caller here takes its
 *  id straight off a URL path, so the shape is checked first and a malformed
 *  id is simply "not found". */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Does this board exist? Selects the id alone rather than going through
 * `getBoard`, which returns the whole `data` blob — up to 2 MB (see the PUT
 * route's cap) for what is only ever an existence question.
 */
export async function boardExists(id) {
  if (typeof id !== "string" || !UUID_RE.test(id)) return false;
  const db = await getDb();
  const rows = await db
    .select({ id: canvasBoards.id })
    .from(canvasBoards)
    .where(eq(canvasBoards.id, id))
    .limit(1);
  return rows.length > 0;
}

/** Metadata only (omits `data`) — keeps the board switcher light. */
export async function listBoards(projectId) {
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

export async function getBoard(id) {
  const db = await getDb();
  const rows = await db.select().from(canvasBoards).where(eq(canvasBoards.id, id)).limit(1);
  const row = rows[0];
  if (!row) return undefined;
  return { ...rowToMeta(row), data: row.data };
}

export async function createBoard(
  projectId,
  name,
  createdBy
) {
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

export async function renameBoard(id, name) {
  const db = await getDb();
  await db
    .update(canvasBoards)
    .set({ name, updatedAt: Date.now() })
    .where(eq(canvasBoards.id, id));
}

export async function deleteBoard(id) {
  const db = await getDb();
  await db.delete(canvasBoards).where(eq(canvasBoards.id, id));
}

/** Autosave: overwrites the graph blob and bumps updatedAt. Returns
 * `undefined` (rather than falsely reporting success) if the board doesn't
 * exist — e.g. deleted from another tab while this one kept autosaving. */
export async function saveBoardData(
  id,
  data
) {
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
