import "dotenv/config";
import { config as loadEnv } from "dotenv";

// Load .env.local (Next.js convention) for migrations/seed.
loadEnv({ path: ".env.local" });

// Scope Drizzle introspection to the application's owned tables. Historical
// Django tables can still exist in long-lived databases after the retired
// port's source was removed, and must not be treated as deletion candidates.
// `test:db:setup` uses this configuration only against CI's disposable,
// freshly-created PostgreSQL database. Production schema changes continue to
// use reviewed migrations and scripts/optimize-history-indexes.js.
const DRIZZLE_OWNED_TABLES = [
  "users",
  "projects",
  "folders",
  "generations",
  "depth_workers",
  "assets",
  "pricing",
  "settings",
  "user_limits",
  "canvas_boards",
  "agent_conversations",
  "agent_conversation_messages",
  "activity_logs",
  "login_attempts",
];

const config = {
  schema: "./src/lib/schema.js",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL || "",
  },
  tablesFilter: DRIZZLE_OWNED_TABLES,
};

export default config;
