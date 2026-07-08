import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

/**
 * Drizzle client over postgres.js. postgres.js connects lazily (only on the
 * first query), so importing this without DATABASE_URL won't fail at build —
 * it fails only if a query actually runs without config.
 *
 * The connection is cached on globalThis to avoid exhausting connections 
 * during dev hot-reload.
 */
const connectionString =
  process.env.DATABASE_URL || "postgres://invalid:invalid@localhost:5432/none";

const globalForDb = globalThis as unknown as {
  __pg?: ReturnType<typeof postgres>;
};

const client =
  globalForDb.__pg ?? postgres(connectionString, { prepare: false });

if (process.env.NODE_ENV !== "production") globalForDb.__pg = client;

export const db = drizzle(client, { schema });
export { schema };
