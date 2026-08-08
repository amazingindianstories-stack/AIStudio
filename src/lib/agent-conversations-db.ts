import { randomUUID } from "crypto";
import { asc, eq } from "drizzle-orm";
import { getDb } from "./db";
import { agentConversations, agentConversationMessages } from "./schema";
import type { AgentConversationMeta, AgentConversationMessage } from "./agents/orchestrator/types";

export type { AgentConversationMeta, AgentConversationMessage };

/**
 * Orchestrator chat-thread persistence — Postgres `agent_conversations` /
 * `agent_conversation_messages`, mirroring canvas-db.ts's shape/conventions
 * (uuid ids, bigint-ms timestamps, app-supplied crypto.randomUUID()).
 */

type Row = typeof agentConversations.$inferSelect;

function rowToMeta(r: Row): AgentConversationMeta {
  return {
    id: r.id,
    projectId: r.projectId,
    name: r.name,
    kind: r.kind === "legacy" ? "legacy" : "chat",
    createdBy: r.createdBy ?? null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export async function listConversations(projectId: string): Promise<AgentConversationMeta[]> {
  const db = await getDb();
  const rows = await db
    .select()
    .from(agentConversations)
    .where(eq(agentConversations.projectId, projectId));
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

async function insertConversation(
  projectId: string,
  name: string,
  kind: "chat" | "legacy",
  createdBy: string | null
): Promise<AgentConversationMeta> {
  const db = await getDb();
  const now = Date.now();
  const [row] = await db
    .insert(agentConversations)
    .values({ id: randomUUID(), projectId, name, kind, createdBy, createdAt: now, updatedAt: now })
    .returning();
  return rowToMeta(row);
}

export async function createConversation(
  projectId: string,
  name: string,
  createdBy: string | null
): Promise<AgentConversationMeta> {
  return insertConversation(projectId, name, "chat", createdBy);
}

/** Lazily creates the pinned "Old" thread the first time a project's list is
 *  fetched and none exists yet — same lazy-create pattern BoardSwitcher.tsx
 *  already uses for a project's first board. Idempotent per project. */
export async function ensureLegacyConversation(
  projectId: string
): Promise<AgentConversationMeta> {
  const existing = (await listConversations(projectId)).find((c) => c.kind === "legacy");
  if (existing) return existing;
  return insertConversation(projectId, "Old", "legacy", null);
}

export async function renameConversation(id: string, name: string): Promise<void> {
  const db = await getDb();
  await db
    .update(agentConversations)
    .set({ name, updatedAt: Date.now() })
    .where(eq(agentConversations.id, id));
}

/** Refuses to delete the legacy thread — callers must check `kind` first
 *  (the route does, before calling this) since it's the one thread the UI
 *  never offers a delete action for. */
export async function deleteConversation(id: string): Promise<void> {
  const db = await getDb();
  await db
    .delete(agentConversations)
    .where(eq(agentConversations.id, id));
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
