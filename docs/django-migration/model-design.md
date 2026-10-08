# Model design from current repository

Status: design inventory, **not live-schema equivalence or completed ORM qualification**.

All existing SQL names are retained with explicit `db_table` / `db_column`. Millisecond timestamps remain BigIntegerField. Nullable JSON preserves null vs empty array/object. UUID links without declared FKs remain UUIDField; do not introduce cascades or auth_user tables. SQL defaults must survive Django inserts AND non-Django worker inserts.

Composite PKs use Django 5.2 CompositePrimaryKey for user_limits and media_export_items, not synthetic IDs. PostgreSQL RESTRICT must be preserved explicitly in migration SQL: Django on_delete alone does not express physical ON DELETE. Managed state takeover requires catalog proof and reviewed RunSQL; no historical test-managed toggles.

During first read qualification, only User/AppSetting/UserLimit get unmanaged models with recorded migration state. This temporary state does not transfer schema authority. Other models remain design-only until reviewed and qualified.

Concurrency: hierarchy/idempotency/naming/export/generation/depth follow the dedicated invariant sources below. Other tables retain current service transactions; adding generic ModelViewSets would invent mutation behavior.

## authentication.User → `users`

Source: `src/lib/schema.js` export `users`. Runtime owner: Node; future schema/service owner: `authentication`.

Fields, SQL defaults, nullability, PKs, references, on-delete, indexes and checks (verbatim schema declaration, comments removed; unqualified columns are nullable and have no default):

```javascript
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  passwordSalt: text("password_salt").notNull(),
  name: text("name").notNull(),
  role: text("role").notNull().default("user"),
  color: text("color"),
  avatarUrl: text("avatar_url"),
  isActive: boolean("is_active").notNull().default(true),
  authVersion: integer("auth_version").notNull().default(0),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});
```

## projects.Project → `projects`

Source: `src/lib/schema.js` export `projects`. Runtime owner: Node; future schema/service owner: `projects`.

Fields, SQL defaults, nullability, PKs, references, on-delete, indexes and checks (verbatim schema declaration, comments removed; unqualified columns are nullable and have no default):

```javascript
export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  brief: text("brief"),
  createdBy: uuid("created_by"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});
```

## library.Folder → `folders`

Source: `src/lib/schema.js` export `folders`. Runtime owner: Node; future schema/service owner: `library`.

Fields, SQL defaults, nullability, PKs, references, on-delete, indexes and checks (verbatim schema declaration, comments removed; unqualified columns are nullable and have no default):

```javascript
export const folders = pgTable("folders", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").references(() => projects.id, { onDelete: "restrict" }),
  parentId: uuid("parent_id").references(() => folders.id, { onDelete: "restrict" }),
  name: text("name").notNull(),
  nameNormalized: text("name_normalized").notNull().default(""),
  version: integer("version").notNull().default(1),
  color: text("color"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull().default(0),
}, (table) => [
  index("folders_project_id_idx").on(table.projectId),
  index("folders_parent_id_idx").on(table.parentId),
  uniqueIndex("folders_global_root_unique_idx").on(table.nameNormalized).where(sql`${table.parentId} is null and ${table.projectId} is null`),
  uniqueIndex("folders_project_root_unique_idx").on(table.projectId, table.nameNormalized).where(sql`${table.parentId} is null and ${table.projectId} is not null`),
  uniqueIndex("folders_subfolder_unique_idx").on(table.parentId, table.nameNormalized).where(sql`${table.parentId} is not null`),
]);
```

## generation.Generation → `generations`

Source: `src/lib/schema.js` export `generations`. Runtime owner: Node; future schema/service owner: `generation`.

Fields, SQL defaults, nullability, PKs, references, on-delete, indexes and checks (verbatim schema declaration, comments removed; unqualified columns are nullable and have no default):

```javascript
export const generations = pgTable("generations", {
  id: uuid("id").primaryKey().defaultRandom(),
  kind: text("kind").notNull(),
  status: text("status").notNull(),
  prompt: text("prompt").notNull(),
  model: text("model").notNull(),
  aspectRatio: text("aspect_ratio").notNull(),
  resolution: text("resolution"),
  duration: integer("duration"),
  url: text("url"),
  poster: text("poster"),
  error: text("error"),

  providerResponses: jsonb("provider_responses"),
  moderationBlocked: boolean("moderation_blocked"),
  referenceImages: jsonb("reference_images").$type(),




  referenceVideos: jsonb("reference_videos").$type(),
  referenceAudios: jsonb("reference_audios").$type(),
  projectId: uuid("project_id").references(() => projects.id, { onDelete: "restrict" }),
  folderId: uuid("folder_id").references(() => folders.id, { onDelete: "restrict" }),
  userId: uuid("user_id"),
  costCents: integer("cost_cents").notNull().default(0),




  costBasis: text("cost_basis").notNull().default("estimated"),
  isFavorite: boolean("is_favorite").notNull().default(false),
  favoritedAt: bigint("favorited_at", { mode: "number" }),
  taskId: text("task_id"),


  sourceGenerationId: uuid("source_generation_id"),
  draftTaskId: text("draft_task_id"),



  submittedAt: bigint("submitted_at", { mode: "number" }),
  providerCreatedAt: bigint("provider_created_at", { mode: "number" }),
  providerUpdatedAt: bigint("provider_updated_at", { mode: "number" }),
  completedAt: bigint("completed_at", { mode: "number" }),
  lastPollAt: bigint("last_poll_at", { mode: "number" }),
  nextPollAt: bigint("next_poll_at", { mode: "number" }),
  pollAttempts: integer("poll_attempts").notNull().default(0),
  callbackReceivedAt: bigint("callback_received_at", { mode: "number" }),
  providerStatus: text("provider_status"),
  workerLeaseId: text("worker_lease_id"),
  workerLeaseUntil: bigint("worker_lease_until", { mode: "number" }),



  pollErrorCount: integer("poll_error_count").notNull().default(0),
  lastPollErrorAt: bigint("last_poll_error_at", { mode: "number" }),






  generateAudio: boolean("generate_audio"),



  draftMode: boolean("draft_mode"),
  bitrateMode: text("bitrate_mode"),







  videoTaskMode: text("video_task_mode"),







  progressPercent: integer("progress_percent"),
  progressMessage: text("progress_message"),








  trackCharacters: boolean("track_characters"),



  depthClaimId: uuid("depth_claim_id"),
  depthClaimWorkerId: text("depth_claim_worker_id"),
  depthReapAttempts: integer("depth_reap_attempts").notNull().default(0),












  seed: integer("seed"),













  candidateTaskIds: jsonb("candidate_task_ids").$type(),







  continuationFrameUrl: text("continuation_frame_url"),


  lastFrameUrl: text("last_frame_url"),











  flagged: boolean("flagged").notNull().default(false),
  flaggedAt: bigint("flagged_at", { mode: "number" }),
  flagReason: text("flag_reason"),













  judgeScore: jsonb("judge_score").$type(),
  locationVersion: integer("location_version").notNull().default(1),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
}, (table) => [
  index("generations_created_at_idx").on(table.createdAt),
  index("generations_queue_idx").on(table.status, table.kind, table.createdAt),
  index("generations_project_id_idx").on(table.projectId),
  index("generations_folder_id_idx").on(table.folderId),
  index("generations_user_created_idx").on(table.userId, table.createdAt),










  index("generations_created_keyset_idx").on(
    table.createdAt.desc(),
    table.id.desc()
  ),




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



  index("generations_favorite_keyset_idx")
    .on(table.favoritedAt.desc(), table.id.desc())
    .where(sql`${table.isFavorite}`),







  index("generations_flagged_keyset_idx")
    .on(table.flaggedAt.desc(), table.id.desc())
    .where(sql`${table.flagged}`),
  index("generations_stale_video_poll_idx")
    .on(table.updatedAt, table.createdAt, table.id)
    .where(sql`${table.kind} = 'video' and ${table.status} in ('queued', 'running') and ${table.taskId} is not null`),
  index("generations_coordinator_due_idx")
    .on(table.status, table.nextPollAt, table.createdAt)
    .where(sql`(${table.kind} = 'video' and ${table.status} in ('queued', 'running')) or (${table.kind} = 'image' and (${table.status} = 'queued' or (${table.status} = 'running' and ${table.model} like 'Magnific %')))`),
]);
```

## workers.DepthWorker → `depth_workers`

Source: `src/lib/schema.js` export `depthWorkers`. Runtime owner: Node; future schema/service owner: `workers`.

Fields, SQL defaults, nullability, PKs, references, on-delete, indexes and checks (verbatim schema declaration, comments removed; unqualified columns are nullable and have no default):

```javascript
export const depthWorkers = pgTable("depth_workers", {
  id: uuid("id").primaryKey().defaultRandom(),
  workerId: text("worker_id").notNull().unique(),
  label: text("label"),
  device: text("device"),
  status: text("status").notNull().default("idle"),
  currentJobId: uuid("current_job_id"),


  currentClaimId: uuid("current_claim_id"),
  protocolVersion: integer("protocol_version").notNull().default(1),
  ramLimitMb: integer("ram_limit_mb"),
  ramUsedMb: integer("ram_used_mb"),
  lastSeenAt: bigint("last_seen_at", { mode: "number" }).notNull(),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});
```

## assets.Asset → `assets`

Source: `src/lib/schema.js` export `assets`. Runtime owner: Node; future schema/service owner: `assets`.

Fields, SQL defaults, nullability, PKs, references, on-delete, indexes and checks (verbatim schema declaration, comments removed; unqualified columns are nullable and have no default):

```javascript
export const assets = pgTable(
  "assets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description"),
    images: jsonb("images").$type().notNull().default([]),
    projectId: uuid("project_id"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [index("assets_project_id_idx").on(table.projectId)]
);
```

## assets.PortraitGroup → `portrait_groups`

Source: `src/lib/schema.js` export `portraitGroups`. Runtime owner: Node; future schema/service owner: `assets`.

Fields, SQL defaults, nullability, PKs, references, on-delete, indexes and checks (verbatim schema declaration, comments removed; unqualified columns are nullable and have no default):

```javascript
export const portraitGroups = pgTable(
  "portrait_groups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    byteplusGroupId: text("byteplus_group_id").unique(),
    name: text("name").notNull(),
    description: text("description"),
    groupType: text("group_type").notNull().default("AIGC"),
    projectName: text("project_name").notNull().default("default"),
    primaryAssetId: text("primary_asset_id"),
    projectId: uuid("project_id"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [index("portrait_groups_project_id_idx").on(table.projectId)]
);
```

## assets.PortraitAsset → `portrait_assets`

Source: `src/lib/schema.js` export `portraitAssets`. Runtime owner: Node; future schema/service owner: `assets`.

Fields, SQL defaults, nullability, PKs, references, on-delete, indexes and checks (verbatim schema declaration, comments removed; unqualified columns are nullable and have no default):

```javascript
export const portraitAssets = pgTable("portrait_assets", {
  id: uuid("id").primaryKey().defaultRandom(),
  groupId: uuid("group_id")
    .notNull()
    .references(() => portraitGroups.id, { onDelete: "cascade" }),
  byteplusAssetId: text("byteplus_asset_id").unique(),
  name: text("name"),
  assetType: text("asset_type").notNull().default("Image"),
  role: text("role").notNull().default("reference"),
  imageUrl: text("image_url").notNull(),
  status: text("status").notNull().default("Processing"),
  statusMessage: text("status_message"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});
```

## generation.Pricing → `pricing`

Source: `src/lib/schema.js` export `pricing`. Runtime owner: Node; future schema/service owner: `generation`.

Fields, SQL defaults, nullability, PKs, references, on-delete, indexes and checks (verbatim schema declaration, comments removed; unqualified columns are nullable and have no default):

```javascript
export const pricing = pgTable("pricing", {
  model: text("model").primaryKey(),
  unitCostCents: integer("unit_cost_cents").notNull(),
  unit: text("unit").notNull(),
  notes: text("notes"),
});
```

## admin_dashboard.AppSetting → `settings`

Source: `src/lib/schema.js` export `settings`. Runtime owner: Node; future schema/service owner: `admin_dashboard`.

Fields, SQL defaults, nullability, PKs, references, on-delete, indexes and checks (verbatim schema declaration, comments removed; unqualified columns are nullable and have no default):

```javascript
export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});
```

## admin_dashboard.UserLimit → `user_limits`

Source: `src/lib/schema.js` export `userLimits`. Runtime owner: Node; future schema/service owner: `admin_dashboard`.

Fields, SQL defaults, nullability, PKs, references, on-delete, indexes and checks (verbatim schema declaration, comments removed; unqualified columns are nullable and have no default):

```javascript
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
```

## canvas.CanvasBoard → `canvas_boards`

Source: `src/lib/schema.js` export `canvasBoards`. Runtime owner: Node; future schema/service owner: `canvas`.

Fields, SQL defaults, nullability, PKs, references, on-delete, indexes and checks (verbatim schema declaration, comments removed; unqualified columns are nullable and have no default):

```javascript
export const canvasBoards = pgTable("canvas_boards", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull(),
  name: text("name").notNull(),
  data: jsonb("data").$type().notNull(),
  createdBy: uuid("created_by"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
}, (table) => [index("canvas_boards_project_id_idx").on(table.projectId)]);
```

## agents.AgentConversation → `agent_conversations`

Source: `src/lib/schema.js` export `agentConversations`. Runtime owner: Node; future schema/service owner: `agents`.

Fields, SQL defaults, nullability, PKs, references, on-delete, indexes and checks (verbatim schema declaration, comments removed; unqualified columns are nullable and have no default):

```javascript
export const agentConversations = pgTable("agent_conversations", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull(),
  name: text("name").notNull(),





  kind: text("kind").notNull().default("chat"),



  agentKind: text("agent_kind"),
  createdBy: uuid("created_by"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
}, (table) => [
  index("agent_conversations_project_id_idx").on(table.projectId),
  index("agent_conversations_project_kind_idx").on(table.projectId, table.agentKind),
]);
```

## agents.AgentConversationMessage → `agent_conversation_messages`

Source: `src/lib/schema.js` export `agentConversationMessages`. Runtime owner: Node; future schema/service owner: `agents`.

Fields, SQL defaults, nullability, PKs, references, on-delete, indexes and checks (verbatim schema declaration, comments removed; unqualified columns are nullable and have no default):

```javascript
export const agentConversationMessages = pgTable("agent_conversation_messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  conversationId: uuid("conversation_id").notNull(),
  role: text("role").notNull(),
  content: text("content").notNull(),






  toolTrace: jsonb("tool_trace").$type(),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
}, (table) => [
  index("agent_conversation_messages_conversation_id_idx").on(table.conversationId),
]);
```

## common.ActivityLog → `activity_logs`

Source: `src/lib/schema.js` export `activityLogs`. Runtime owner: Node; future schema/service owner: `common`.

Fields, SQL defaults, nullability, PKs, references, on-delete, indexes and checks (verbatim schema declaration, comments removed; unqualified columns are nullable and have no default):

```javascript
export const activityLogs = pgTable("activity_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id"),
  action: text("action").notNull(),
  detail: jsonb("detail"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
}, (table) => [index("activity_logs_created_at_idx").on(table.createdAt)]);
```

## authentication.LoginAttempt → `login_attempts`

Source: `src/lib/schema.js` export `loginAttempts`. Runtime owner: Node; future schema/service owner: `authentication`.

Fields, SQL defaults, nullability, PKs, references, on-delete, indexes and checks (verbatim schema declaration, comments removed; unqualified columns are nullable and have no default):

```javascript
export const loginAttempts = pgTable("login_attempts", {
  id: uuid("id").primaryKey().defaultRandom(),
  identifier: text("identifier").notNull(),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
}, (table) => [
  index("login_attempts_identifier_created_idx").on(table.identifier, table.createdAt),
]);
```

## exports.MediaExport → `media_exports`

Source: `src/lib/schema.js` export `mediaExports`. Runtime owner: Node; future schema/service owner: `exports`.

Fields, SQL defaults, nullability, PKs, references, on-delete, indexes and checks (verbatim schema declaration, comments removed; unqualified columns are nullable and have no default):

```javascript
export const mediaExports = pgTable("media_exports", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull(),
  status: text("status").notNull().default("draft"),
  totalItems: integer("total_items").notNull().default(0),
  processedItems: integer("processed_items").notNull().default(0),
  skippedItems: integer("skipped_items").notNull().default(0),
  warnings: jsonb("warnings").$type().notNull().default([]),
  attemptCount: integer("attempt_count").notNull().default(0),
  leaseOwner: text("lease_owner"),
  leaseUntil: bigint("lease_until", { mode: "number" }),
  outputKey: text("output_key"),
  outputBytes: bigint("output_bytes", { mode: "number" }),
  error: text("error"),
  manifestVersion: integer("manifest_version").notNull().default(1),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  expiresAt: bigint("expires_at", { mode: "number" }),
}, (table) => [
  index("media_exports_user_created_idx").on(table.userId, table.createdAt.desc()),
  index("media_exports_worker_due_idx").on(table.status, table.leaseUntil, table.createdAt),
]);
```

## exports.MediaExportItem → `media_export_items`

Source: `src/lib/schema.js` export `mediaExportItems`. Runtime owner: Node; future schema/service owner: `exports`.

Fields, SQL defaults, nullability, PKs, references, on-delete, indexes and checks (verbatim schema declaration, comments removed; unqualified columns are nullable and have no default):

```javascript
export const mediaExportItems = pgTable("media_export_items", {
  exportId: uuid("export_id").notNull().references(() => mediaExports.id, { onDelete: "cascade" }),
  generationId: uuid("generation_id").notNull(),
  position: integer("position").notNull(),
  sourceKey: text("source_key").notNull(),
  filename: text("filename").notNull(),
}, (table) => [
  primaryKey({ columns: [table.exportId, table.generationId] }),
  index("media_export_items_order_idx").on(table.exportId, table.position),
]);
```

## library.OrganizationIdempotencyKey → `organization_idempotency_keys`

Source: `src/lib/schema.js` export `organizationIdempotencyKeys`. Runtime owner: Node; future schema/service owner: `library`.

Fields, SQL defaults, nullability, PKs, references, on-delete, indexes and checks (verbatim schema declaration, comments removed; unqualified columns are nullable and have no default):

```javascript
export const organizationIdempotencyKeys = pgTable("organization_idempotency_keys", {
  key: text("key").primaryKey(),
  actorId: text("actor_id"),
  operation: text("operation").notNull(),
  fingerprint: text("fingerprint").notNull(),
  status: text("status").notNull().default("completed"),
  result: jsonb("result"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
}, (table) => [
  index("organization_idempotency_keys_created_idx").on(table.createdAt),
  index("organization_idempotency_keys_expires_idx").on(table.expiresAt),
  index("organization_idempotency_keys_actor_op_idx").on(table.actorId, table.operation),
]);
```

## library.NamingCounter → `naming_counters`

Source: `src/lib/schema.js` export `namingCounters`. Runtime owner: Node; future schema/service owner: `library`.

Fields, SQL defaults, nullability, PKs, references, on-delete, indexes and checks (verbatim schema declaration, comments removed; unqualified columns are nullable and have no default):

```javascript
export const namingCounters = pgTable("naming_counters", {
  namespace: text("namespace").primaryKey(),
  nextSequence: bigint("next_sequence", { mode: "number" }).notNull().default(1),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});
```

## library.GenerationNaming → `generation_naming`

Source: `src/lib/schema.js` export `generationNaming`. Runtime owner: Node; future schema/service owner: `library`.

Fields, SQL defaults, nullability, PKs, references, on-delete, indexes and checks (verbatim schema declaration, comments removed; unqualified columns are nullable and have no default):

```javascript
export const generationNaming = pgTable("generation_naming", {
  generationId: uuid("generation_id").primaryKey().references(() => generations.id, { onDelete: "cascade" }),
  namespace: text("namespace").notNull(),
  sequence: bigint("sequence", { mode: "number" }).notNull(),
  assignedAt: bigint("assigned_at", { mode: "number" }).notNull(),
}, (table) => [
  uniqueIndex("generation_naming_namespace_seq_idx").on(table.namespace, table.sequence),
  index("generation_naming_namespace_idx").on(table.namespace),
  check("generation_naming_sequence_check", sql`${table.sequence} > 0`),
]);
```

## Invariants beyond the ORM declaration

Current implementation addition: OrganizationIdempotencyKey, NamingCounter and
GenerationNaming now have unmanaged Django declarations and library migration
0002 state. All current columns, nullability and nonstandard primary keys are
represented; Python defaults mirror completed status and initial counter 1.
Those Python defaults do not establish SQL-default equivalence. GenerationNaming
currently stores the UUID directly; the generation relationship/CASCADE, indexes,
checks and deferred naming triggers remain physical-baseline work. No schema
authority transfers through these declarations. Isolated ORM roundtrips verify
nullable Unicode JSON, UUID keys and bigint values above JavaScript's safe integer
range. `makemigrations --check --dry-run` detects no drift; `sqlmigrate library
0002` emits only transaction/comments/no-ops, no application DDL.

- `scripts/migrate-hierarchical-folders.js`: normalization function/trigger; deferred folder scope/cycle and generation scope constraint triggers; relational RESTRICT constraints and idempotency table. `src/lib/folder-engine.js` owns sorted advisory/row locks, scope revalidation, batch atomicity and optimistic versions.
- `scripts/migrate-generation-naming.js`: positive sequences; deferred naming/location triggers and custom functions; allocation/backfill rules. `generation-naming.js` atomically advances counters; `filename-resolver.js` defines names.
- `scripts/migrate-folder-color.js`: additive color column and check; pending user work is part of baseline.
- `media-exports-db.js`: user ownership, immutable finalized names, job lease fencing and retries; not all invariants are DB constraints.
- `generation-coordinator.js`, `store-db.js`, `depth-jobs-db.js`: lease fencing, admission locks, atomic status changes, depth claim tokens.
- `distributed-lease.js`: verify whether auxiliary runtime DDL adds any tables beyond schema inventory before schema takeover.

## Gate still open

Audit the actual PostgreSQL catalog, including residual Django tables, auxiliary tables, functions, trigger definitions, validation/deferrability, index expressions/opclasses, defaults, collation and extensions. Every unexpected object needs an explicit preserve/exclude/migrate decision. Reproduce an empty PostgreSQL 16 DB solely with Django migrations and compare semantic catalog snapshots. Existing production baseline requires backup/PITR and exact acceptable equivalence; fake-initial alone is insufficient. No production DB has been accessed.

## Catalog evidence tooling

`scripts/django-migration/schema-catalog.py` captures public tables/columns,
defaults/nullability/collation/identity, physical FK/check deferrability and
validation, full index expressions/validity, custom trigger definitions, function
bodies and extension versions in a read-only repeatable-read transaction.
It accepts only the explicitly disposable loopback migration target. `compare`
compares saved JSON locally and exits nonzero for any differing category; it does
not normalize away SQL or naming differences. Real DDL qualification proves
changes to defaults, constraints and indexes are detected. Trigger/function
coverage, additional schemas/types/sequences and reviewed equivalence policy
still need qualification before this can serve as the schema takeover gate.
No Django-only full baseline or production catalog comparison exists yet.

Collector extension: public sequence configuration (excluding mutable last-value
state), enum labels/order and domain definitions are included. Real fixtures
prove function-body, deferred-trigger enabled-state and sequence-increment changes
are detected. Snapshot comparison rejects missing categories or malformed rows.
Additional-schema scope and full baseline reproduction still require work.

## Current unmanaged declaration inventory (2026-10-08)

All 21 current Drizzle tables now have domain model declarations. The last four
are generation.Generation (60 columns), workers.DepthWorker (12 columns),
exports.MediaExport (17 columns) and exports.MediaExportItem (five physical
columns, composite key). The generation project/folder relations use RESTRICT;
export items use CASCADE for export_id and a plain generation_id UUID, matching
current declarations. Model-state migrations retain these relationships but
emit no physical DDL while managed=False. This inventory is a starting point for
complete physical equivalence; it does not close the baseline gate. SQL UUID
and other defaults, complete indexes, functions, triggers, constraint behavior,
and production catalog comparison must still be represented and verified before
Django becomes schema authority. Runtime/API/provider/worker ownership is unchanged.

The declaration guard checks 205 columns, primary keys and foreign-key targets
and deletion policies in both runtime and migration state. Folder project and
parent relationships and GenerationNaming's generation relationship now match
current Drizzle declarations (RESTRICT, RESTRICT and CASCADE respectively).
The unmanaged library 0003 migration changes model state only. The guard does
not claim equivalence of physical constraint deferrability or SQL defaults;
those remain the catalog/baseline gate's responsibility.

Generation index state now declares twelve current indexes: created, queue,
project/folder, user-created, created/project/folder keysets, and favorite/flagged
partial keysets, plus stale-video polling and worker-coordinator predicates. Original PostgreSQL names are preserved with a 63-character
index subclass. Migrations 0002 and 0003 use SeparateDatabaseAndState with no database
operations; it does not create/change physical indexes or transfer schema
authority. Runtime/disk column order, direction and boolean predicates match
current Drizzle metadata, including compound worker predicates. Static RawSQL
preserves their grouping and LIKE condition; its percent literal is escaped for
Django SQL formatting. Physical/default/constraint/trigger baselining and complete
catalog proof remain pending. Worker ownership remains Node.

The generation declaration comparison now also checks NULL ordering in compiled
CREATE INDEX SQL. The previous field shorthand used PostgreSQL DESC NULLS FIRST,
whereas current Drizzle declares DESC NULLS LAST. State-only migration 0004
replaces five keyset index declarations with explicit OrderBy expressions; it
emits no physical DDL. All twelve declarations now match including NULL ordering.
A CI probe creates indexes on transactional temporary tables for both runtime
and disk state, then reads pg_index ordering flags: 24 checks pass. Two negative
controls reproduce and reject the previous DESC NULLS FIRST behavior. All
temporary objects are rolled back and verified absent. This proves exercised
index column ordering, not full physical catalog equivalence, defaults, unique
constraints or baseline readiness. Production schema and ownership are unchanged.

All current Drizzle-declared indexes are now represented in Django runtime and
disk state: 33 across the 21-table inventory. The remaining declarations include
folder partial uniqueness, generation namespace/sequence uniqueness, export
ordering and due-work indexes, organizational idempotency, agents, assets, login
attempts and activity logs. PostgreSQLUniqueIndex preserves a unique index's
catalog object form rather than replacing it with an unconditional unique
constraint. Seven new migrations use empty database operations; sqlmigrate
confirms each emits no physical DDL. Existing Canvas and portrait-group indexes
were present at runtime but missing from initial unmanaged migration state;
explicit state operations correct that gap.

The new CI index-state guard compares inventory, uniqueness, columns, direction,
NULL ordering and predicates against current metadata. The physical temporary
table probe verifies 66 indexes across runtime/disk states, including catalog
uniqueness and partial-index presence. Twenty-four insert checks exercise folder
root/child collision scopes and namespace/sequence collisions, including allowed
different scopes/sequences. All temporary objects are rolled back and verified
absent. The 42 Django regression tests, 205-column guard, system checks and
makemigrations consistency pass. This is declared-index preparation and isolated
behavior evidence, not production catalog equivalence: migration-script-only
objects, defaults, constraints, functions, triggers and Django-only baseline
reproduction still require the takeover gate. Drizzle remains schema authority;
no runtime, provider, worker or production traffic ownership transferred.

Django runtime/disk state now declares the current positive generation-naming
sequence check and the folder-color check from the current additive migration
source. Library migration 0005 has empty database operations; sqlmigrate confirms
no physical DDL. A CI probe derives the sequence condition from Drizzle metadata
and reads the color migration as text without importing its dotenv/DB entrypoint.
On rolled-back temporary PostgreSQL tables, source SQL and both Django states
produce identical canonical constraint definitions and validation/deferrability
flags (four comparisons). Fifty-seven insert checks cover all eight colors, null,
invalid/blank/case/whitespace variants, nonpositive sequences, positive sequences
and bigint maximum. Null sequence passes the CHECK alone; the existing column
nullability guard remains responsible for its NOT NULL declaration. All objects
are rolled back and verified absent. Django system checks, migration consistency
and 42 regression tests pass. Local verification uses disposable PostgreSQL 18;
CI runs the probe on its PostgreSQL 16 service. This does not prove deferred scope
triggers, physical NOT NULL/FK/default equivalence or production baseline readiness.
No schema authority or production ownership changed.

All 46 current Drizzle database defaults now have Django `db_default` declarations
in runtime and disk migration state. They include fourteen gen_random_uuid()
fallbacks, literal text/numeric/boolean defaults and two JSON array defaults.
Existing Python-side defaults are preserved. Ten migrations use empty database
operations; sqlmigrate confirms no physical DDL. The CI default probe imports
schema metadata only and rejects unsupported SQL/runtime default forms.

Disposable temporary tables compare PostgreSQL's canonical default expressions
for all 205 columns in both Django states: 410 comparisons pass, including absent
defaults. Source/runtime/disk SQL inserts verify 573 literal/absent values and 42
UUID-v4 fallbacks. Actual Django ORM omitted-field inserts verify all 46 defaults
in both registries (92 checks). Raw cursor JSON values require JSON decoding
before comparing with fixture arrays; ORM JSON values are already decoded. All
temporary objects are rolled back and verified absent. System checks, migration
consistency and 42 Django regression tests pass. Local PostgreSQL is version 18;
CI's configured PostgreSQL 16 service runs this qualification.

This is declared-default equivalence, not a complete Django-only schema baseline
or production-catalog comparison. Temporary default tables intentionally omit
NOT NULL/FK/index/trigger rules to isolate defaults; those require their own
physical qualification. Current migration-script-only defaults and unexpected
production objects remain subject to the baseline gate. Drizzle and runtime
ownership remain unchanged; no production DDL or traffic transfer occurred.

Whole-schema reproduction diagnostic now exists in
`scripts/django-migration/schema-reproduction-probe.py`. It builds a fresh current
Drizzle fixture plus current hierarchy/naming SQL and color check, then a fresh
fixture materialized from disk Django migration model state. Both use the same
scratch namespace in separate rolled-back transactions. No public application
DDL is applied. This is not yet a Django-migrations-only baseline.

The current local PostgreSQL 18 comparison is **not equivalent**. Both fixtures
have 21 tables/205 columns. Five categories differ: columns, constraints, indexes,
functions and triggers. The 79 differing column rows differ only in physical
ordinal position; types/nullability/defaults match. The current fixture has 58
indexes versus Django's 72: implicit FK and text pattern indexes add objects, and
unique/composite-PK names differ. Current SQL FKs preserve immediate RESTRICT or
CASCADE; Django schema_editor generates deferred FKs without those SQL deletion
clauses. Django's on_delete service policy does not prove physical FK equivalence.
Current additive scripts also yield duplicate named FK constraints in this
fresh-fixture path; actual production presence must be audited before any
preserve/exclude decision. Four custom functions/five triggers are missing from
Django reproduction. PostgreSQL 18 NOT NULL catalog constraints are version
specific; PostgreSQL 16 comparison is still required.

The detailed synthetic fixture report is `schema-reproduction-gaps.json`. No
automatic normalization or waiver hides these differences. Diagnostic mode exits
successfully after capturing evidence; `--require-equivalent` deliberately exits
1 for this incomplete state. Both modes verify scratch-schema rollback. This
report is a baseline blocker, not schema takeover approval or production proof.
Next baseline work must represent exact physical FK behavior and names, remove
unintended indexes, preserve/check physical column order, and port current
functions/triggers into Django migration SQL before testing an empty Django-only
baseline and reviewing the real production catalog. Authority remains Drizzle.
