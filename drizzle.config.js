import "dotenv/config";
import { config } from "dotenv";

// Load .env.local (Next.js convention) for migrations/seed.
config({ path: ".env.local" });

export default {
  schema: "./src/lib/schema.js",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL || "",
  },
};
