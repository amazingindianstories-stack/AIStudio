import { randomUUID } from "crypto";
import { and, asc, eq } from "drizzle-orm";
import { getDb } from "./db";
import { agentConversations, agentConversationMessages } from "./schema";

;

/**
 * Orchestrator chat-thread persistence — Postgres `agent_conversations` /
 * `agent_conversation_messages`, mirroring canvas-db.ts's shape/conventions
 * (uuid ids, bigint-ms timestamps, app-supplied crypto.randomUUID()).
 *
 * Every thread belongs to exactly one tab (agentKind: "image" | "video") —
 * the pre-StudioChat "legacy" pinned-thread concept is gone; the old feed
 * has its own nav entry (LegacyHistoryModal) instead of a row here.
 */

function rowToMeta(r) {
  return {
    id: r.id,
    projectId: r.projectId,
    name: r.name,
    // Defensive fallback for rows written before this column existed.
    agentKind: r.agentKind === "video" ? "video" : "image",
    createdBy: r.createdBy ?? null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export async function listConversations(
  projectId,
  agentKind
) {
  const db = await getDb();
  const rows = await db
    .select()
    .from(agentConversations)
    .where(
      and(eq(agentConversations.projectId, projectId), eq(agentConversations.agentKind, agentKind))
    );
  return rows.map(rowToMeta);
}

export async function getConversation(id) {
  const db = await getDb();
  const rows = await db
    .select()
    .from(agentConversations)
    .where(eq(agentConversations.id, id))
    .limit(1);
  return rows[0] ? rowToMeta(rows[0]) : undefined;
}

export async function createConversation(
  projectId,
  agentKind,
  name,
  createdBy
) {
  const db = await getDb();
  const now = Date.now();
  const [row] = await db
    .insert(agentConversations)
    .values({ id: randomUUID(), projectId, agentKind, name, createdBy, createdAt: now, updatedAt: now })
    .returning();
  return rowToMeta(row);
}

export async function renameConversation(id, name) {
  const db = await getDb();
  await db
    .update(agentConversations)
    .set({ name, updatedAt: Date.now() })
    .where(eq(agentConversations.id, id));
}

export async function deleteConversation(id) {
  const db = await getDb();
  await db.delete(agentConversations).where(eq(agentConversations.id, id));
  await db
    .delete(agentConversationMessages)
    .where(eq(agentConversationMessages.conversationId, id));
}

export async function listMessages(
  conversationId
) {
  const db = await getDb();
  const rows = await db
    .select()
    .from(agentConversationMessages)
    .where(eq(agentConversationMessages.conversationId, conversationId))
    .orderBy(asc(agentConversationMessages.createdAt));
  return rows.map((r) => ({
    id: r.id,
    conversationId: r.conversationId,
    role: r.role === "assistant" ? "assistant" : "user",
    content: r.content,
    toolTrace: r.toolTrace ?? null,
    createdAt: r.createdAt,
  }));
}

/** Attaches the id of the GenerationItem a message's tool call actually
 *  produced, once s.generate() (client-side, after the message is already
 *  persisted) creates it — so a reload can tell a finished generation from
 *  one that's still running instead of showing "Starting…" forever. No-op
 *  (returns undefined) if the message has no toolTrace to attach onto. */
export async function attachGeneratedItem(
  messageId,
  itemId
) {
  const db = await getDb();
  const rows = await db
    .select()
    .from(agentConversationMessages)
    .where(eq(agentConversationMessages.id, messageId))
    .limit(1);
  const existing = rows[0];
  if (!existing || !existing.toolTrace) return undefined;
  const toolTrace = { ...existing.toolTrace, generatedItemId: itemId };
  const [row] = await db
    .update(agentConversationMessages)
    .set({ toolTrace })
    .where(eq(agentConversationMessages.id, messageId))
    .returning();
  return {
    id: row.id,
    conversationId: row.conversationId,
    role: row.role === "assistant" ? "assistant" : "user",
    content: row.content,
    toolTrace: row.toolTrace ?? null,
    createdAt: row.createdAt,
  };
}

export async function appendMessage(
  conversationId,
  role,
  content,
  toolTrace = null
) {
  const db = await getDb();
  const now = Date.now();
  const [row] = await db
    .insert(agentConversationMessages)
    .values({ id: randomUUID(), conversationId, role, content, toolTrace, createdAt: now })
    .returning();
  await db
    .update(agentConversations)
    .set({ updatedAt: now })
    .where(eq(agentConversations.id, conversationId));
  return {
    id: row.id,
    conversationId: row.conversationId,
    role: row.role === "assistant" ? "assistant" : "user",
    content: row.content,
    toolTrace: row.toolTrace ?? null,
    createdAt: row.createdAt,
  };
}
