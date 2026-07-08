/**
 * Drizzle schema → Supabase Postgres. Timestamps are stored as bigint ms
 * (Date.now()) to match the numbers the app already uses throughout. UUID ids
 * are supplied by the app (crypto.randomUUID()) on insert, matching the
 * existing flow; defaultRandom() is just a fallback.
 */
import {
  pgTable,
  text,
  bigint,
  integer,
  boolean,
  jsonb,
  uuid,
} from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  passwordSalt: text("password_salt").notNull(),
  name: text("name").notNull(),
  role: text("role").notNull().default("user"), // 'admin' | 'user'
  color: text("color"), // avatar color (hex)
  isActive: boolean("is_active").notNull().default(true),
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
  projectId: uuid("project_id"),
  folderId: uuid("folder_id"),
  userId: uuid("user_id"),
  costCents: integer("cost_cents").notNull().default(0),
  isFavorite: boolean("is_favorite").notNull().default(false),
  favoritedAt: bigint("favorited_at", { mode: "number" }),
  taskId: text("task_id"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});

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

export const activityLogs = pgTable("activity_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id"),
  action: text("action").notNull(), // 'login' | 'logout' | 'generate' | ...
  detail: jsonb("detail"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});
