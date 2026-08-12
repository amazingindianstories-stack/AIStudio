/**
 * Drizzle schema for PostgreSQL (Cloud SQL in production). Timestamps are bigint ms
 * (Date.now()) to match the numbers the app already uses throughout. UUID ids
 * are supplied by the app (crypto.randomUUID()) on insert, matching the
 * existing flow; defaultRandom() is just a fallback.
 */
import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  bigint,
  integer,
  boolean,
  jsonb,
  uuid,
  index,
  primaryKey,
} from "drizzle-orm/pg-core";
import type { CanvasState } from "./canvas/types";

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  passwordSalt: text("password_salt").notNull(),
  name: text("name").notNull(),
  role: text("role").notNull().default("user"), // 'admin' | 'user'
  color: text("color"), // avatar color (hex)
  avatarUrl: text("avatar_url"),
  isActive: boolean("is_active").notNull().default(true),
  authVersion: integer("auth_version").notNull().default(0),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});

export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  brief: text("brief"),
  createdBy: uuid("created_by"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});

export const folders = pgTable("folders", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull(),
  name: text("name").notNull(),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});

export const generations = pgTable("generations", {
  id: uuid("id").primaryKey().defaultRandom(),
  kind: text("kind").notNull(), // 'image' | 'video'
  status: text("status").notNull(),
  prompt: text("prompt").notNull(),
  model: text("model").notNull(),
  aspectRatio: text("aspect_ratio").notNull(),
  resolution: text("resolution"),
  duration: integer("duration"),
  url: text("url"),
  poster: text("poster"),
  error: text("error"),
  moderationBlocked: boolean("moderation_blocked"),
  referenceImages: jsonb("reference_images").$type<string[]>(),
  // Stored media refs for clips used as `reference_video` on BytePlus. Kept
  // apart from referenceImages because they take a completely different route
  // to the provider: images are inlined as base64, videos are handed over as
  // short-lived presigned URLs (see queue/execute).
  referenceVideos: jsonb("reference_videos").$type<string[]>(),
  projectId: uuid("project_id"),
  folderId: uuid("folder_id"),
  userId: uuid("user_id"),
  costCents: integer("cost_cents").notNull().default(0),
  isFavorite: boolean("is_favorite").notNull().default(false),
  favoritedAt: bigint("favorited_at", { mode: "number" }),
  taskId: text("task_id"),
  // Whether the video was requested with a synchronised audio track (BytePlus
  // ModelArk only — see config.ts supportsAudio). It has to be persisted, not
  // just passed through: /api/generate/video merely enqueues, and it is
  // /api/queue/execute that submits to the provider, so the row is the only
  // thing carrying the request between them. Nullable = "never asked",
  // i.e. every row that predates this column.
  generateAudio: boolean("generate_audio"),
  // Seedance 2.5 only: "edit" | "extend" | null (= "generate", the default
  // path every other model and Seedance 2.0 always use). Persisted for the
  // same reason as generateAudio — /api/generate/video only enqueues and
  // /api/queue/execute is what submits, so the row is the only thing
  // carrying the choice between them, and it also has to survive to the
  // status-poll route so the exact post-generation billing correction knows
  // which per-token rate applied.
  videoTaskMode: text("video_task_mode"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
}, (table) => [
  index("generations_created_at_idx").on(table.createdAt),
  index("generations_queue_idx").on(table.status, table.kind, table.createdAt),
  index("generations_project_id_idx").on(table.projectId),
  index("generations_folder_id_idx").on(table.folderId),
  index("generations_user_created_idx").on(table.userId, table.createdAt),

  // ── keyset-pagination indexes ────────────────────────────────────────────
  // Every library feed pages with a row-value keyset on (created_at, id) in
  // DESC order (store-db.ts queryHistory). The trailing `id` is not decorative:
  // created_at is a millisecond bigint and batch generation inserts several
  // rows inside the same millisecond, so a cursor on created_at alone either
  // skips or repeats rows at a page boundary. Column order and direction here
  // mirror the ORDER BY exactly so Postgres can walk the index instead of
  // sorting, which is what makes page 1 of a two-year-old project cost the
  // same as page 1 of today's.
  index("generations_created_keyset_idx").on(
    table.createdAt.desc(),
    table.id.desc()
  ),
  // Scope-leading variants: the equality column comes first so the scan is a
  // range read inside one project/folder rather than a filter over the whole
  // table. These are what removed the "scroll through all of history to reach
  // an old project" behaviour.
  index("generations_project_keyset_idx").on(
    table.projectId,
    table.createdAt.desc(),
    table.id.desc()
  ),
  index("generations_folder_keyset_idx").on(
    table.folderId,
    table.createdAt.desc(),
    table.id.desc()
  ),
  // Favourites sort by when they were starred, not when they were made, so
  // they need their own ordering. Partial: only a tiny fraction of rows are
  // favourited, so the index stays small enough to stay hot.
  index("generations_favorite_keyset_idx")
    .on(table.favoritedAt.desc(), table.id.desc())
    .where(sql`${table.isFavorite}`),
]);

export const assets = pgTable("assets", {
  id: uuid("id").primaryKey().defaultRandom(),
  kind: text("kind").notNull(),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  description: text("description"),
  images: jsonb("images").$type<string[]>().notNull().default([]),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});

export const pricing = pgTable("pricing", {
  model: text("model").primaryKey(),
  unitCostCents: integer("unit_cost_cents").notNull(),
  unit: text("unit").notNull(), // 'per_image' | 'per_second'
  notes: text("notes"),
});

// Generic admin-editable key/value settings — mirrors `pricing`'s shape
// (small, admin-editable table) rather than a dedicated column per setting,
// so future admin controls (this is the first) don't each need their own
// migration. Value is always stored as text; readers parse/validate it.
export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});

// Per-user overrides of `settings` rows — same key/value shape, scoped to a
// user instead of the whole app. One generic table for every override type
// rather than a dedicated nullable column per limit on `users`, so adding a
// new limit (src/lib/limits.ts's LIMIT_DEFINITIONS) never needs a migration
// or new columns — only a new registry entry. A user with no row for a given
// key has no override for it; absence itself is the "use the global
// default" signal, not a stored value that could drift from later changes
// to that default.
export const userLimits = pgTable(
  "user_limits",
  {
    userId: uuid("user_id").notNull(),
    key: text("key").notNull(),
    value: text("value").notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.key] })]
);

export const canvasBoards = pgTable("canvas_boards", {
  id: uuid("id").primaryKey().defaultRandom(), // app supplies crypto.randomUUID()
  projectId: uuid("project_id").notNull(),
  name: text("name").notNull(),
  data: jsonb("data").$type<CanvasState>().notNull(), // whole graph
  createdBy: uuid("created_by"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
}, (table) => [index("canvas_boards_project_id_idx").on(table.projectId)]);

export const agentConversations = pgTable("agent_conversations", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull(),
  name: text("name").notNull(),
  // Unused as of the StudioChat redesign (was "chat" | "legacy" — the legacy
  // pinned-thread concept is gone now that the old generation feed has its
  // own nav entry, LegacyHistoryModal, instead of living in this table).
  // Left in place rather than dropped — no destructive ALTER on a column
  // that already has rows.
  kind: text("kind").notNull().default("chat"),
  // Which tab this thread belongs to — "image" or "video". Nullable only
  // because rows created before this column existed have none; every row
  // created going forward always sets it (see agent-conversations-db.ts).
  agentKind: text("agent_kind"),
  createdBy: uuid("created_by"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
}, (table) => [
  index("agent_conversations_project_id_idx").on(table.projectId),
  index("agent_conversations_project_kind_idx").on(table.projectId, table.agentKind),
]);

export const agentConversationMessages = pgTable("agent_conversation_messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  conversationId: uuid("conversation_id").notNull(),
  role: text("role").notNull(), // "user" | "assistant"
  content: text("content").notNull(),
  // Which subagent tool ran (if any) and its output, so the UI can show a
  // trace chip above the reply. Not a provider-protocol replay — each turn
  // is rebuilt from role+content, not raw functionCall/functionResponse parts.
  // generatedItemId (optional, on the same object) is attached after the
  // fact once the client's own s.generate() call actually creates a row —
  // see AgentConversationToolTrace's doc comment.
  toolTrace: jsonb("tool_trace").$type<
    { tool: string; args: unknown; result: unknown; generatedItemId?: string } | null
  >(),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
}, (table) => [
  index("agent_conversation_messages_conversation_id_idx").on(table.conversationId),
]);

export const activityLogs = pgTable("activity_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id"),
  action: text("action").notNull(), // 'login' | 'logout' | 'generate' | ...
  detail: jsonb("detail"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
}, (table) => [index("activity_logs_created_at_idx").on(table.createdAt)]);
