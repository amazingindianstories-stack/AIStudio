import { randomUUID } from "crypto";
import { and, asc, eq } from "drizzle-orm";
import { getDb } from "./db";
import { agentConversations, agentConversationMessages } from "./schema";
import type {
  AgentConversationMeta,
  AgentConversationMessage,
  AgentKind,
} from "./agents/orchestrator/types";

export type { AgentConversationMeta, AgentConversationMessage, AgentKind };

/**
 * Orchestrator chat-thread persistence — Postgres `agent_conversations` /
 * `agent_conversation_messages`, mirroring canvas-db.ts's shape/conventions
 * (uuid ids, bigint-ms timestamps, app-supplied crypto.randomUUID()).
 *
 * Every thread belongs to exactly one tab (agentKind: "image" | "video") —
 * the pre-StudioChat "legacy" pinned-thread concept is gone; the old feed
 * has its own nav entry (LegacyHistoryModal) instead of a row here.
 */

type Row = typeof agentConversations.$inferSelect;

function rowToMeta(r: Row): AgentConversationMeta {
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
  projectId: string,
  agentKind: AgentKind
): Promise<AgentConversationMeta[]> {
  const db = await getDb();
  const rows = await db
    .select()
    .from(agentConversations)
    .where(
      and(eq(agentConversations.projectId, projectId), eq(agentConversations.agentKind, agentKind))
    );
  return rows.map(rowToMeta);
}

export async function getConversation(id: string): Promise<AgentConversationMeta | undefined> {
  const db = await getDb();
  const rows = await db
    .select()
    .from(agentConversations)
    .where(eq(agentConversations.id, id))
    .limit(1);
  return rows[0] ? rowToMeta(rows[0]) : undefined;
}

export async function createConversation(
  projectId: string,
  agentKind: AgentKind,
  name: string,
  createdBy: string | null
): Promise<AgentConversationMeta> {
  const db = await getDb();
  const now = Date.now();
  const [row] = await db
    .insert(agentConversations)
    .values({ id: randomUUID(), projectId, agentKind, name, createdBy, createdAt: now, updatedAt: now })
    .returning();
  return rowToMeta(row);
}

export async function renameConversation(id: string, name: string): Promise<void> {
  const db = await getDb();
  await db
    .update(agentConversations)
    .set({ name, updatedAt: Date.now() })
    .where(eq(agentConversations.id, id));
}

export async function deleteConversation(id: string): Promise<void> {
  const db = await getDb();
  await db.delete(agentConversations).where(eq(agentConversations.id, id));
  await db
    .delete(agentConversationMessages)
    .where(eq(agentConversationMessages.conversationId, id));
}

export async function listMessages(
  conversationId: string
): Promise<AgentConversationMessage[]> {
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

export async function appendMessage(
  conversationId: string,
  role: "user" | "assistant",
  content: string,
  toolTrace: { tool: string; args: unknown; result: unknown } | null = null
): Promise<AgentConversationMessage> {
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
