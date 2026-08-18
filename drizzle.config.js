import "dotenv/config";
import { config } from "dotenv";

// Load .env.local (Next.js convention) for migrations/seed.
config({ path: ".env.local" });

// Django's own migrations (manage.py migrate) create auth_*/django_*/etc.
// tables in this same Postgres database — see CLAUDE.md's backend/ section.
// Those aren't declared here since Django owns them, but `drizzle-kit push`
// treats "in the DB but not in this schema" as "drop it" by default, which
// would nuke Django's migration state and permissions tables. tablesFilter
// scopes push/introspection to exactly the tables this file defines.
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

export default {
  schema: "./src/lib/schema.js",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL || "",
  },
  tablesFilter: DRIZZLE_OWNED_TABLES,
};
