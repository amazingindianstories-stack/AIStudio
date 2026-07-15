import {
  AuthTypes,
  Connector,
  IpAddressTypes,
} from "@google-cloud/cloud-sql-connector";
import { drizzle as drizzleNodePg } from "drizzle-orm/node-postgres";
import { drizzle as drizzlePostgresJs } from "drizzle-orm/postgres-js";
import pg from "pg";
import postgres from "postgres";
import { getGoogleAuth } from "./gcp-auth";
import * as schema from "./schema";

type Database = ReturnType<typeof drizzlePostgresJs<typeof schema>>;

interface DbRuntime {
  promise?: Promise<Database>;
  directClient?: ReturnType<typeof postgres>;
  cloudSqlConnector?: Connector;
  cloudSqlPool?: pg.Pool;
}

const globalForDb = globalThis as unknown as { __luminaDb?: DbRuntime };
const runtime = globalForDb.__luminaDb ?? {};
globalForDb.__luminaDb = runtime;

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function createDatabase(): Promise<Database> {
  const instanceConnectionName = process.env.CLOUD_SQL_INSTANCE_CONNECTION_NAME;
  if (process.env.DATABASE_BACKEND === "cloud-sql") {
    if (!instanceConnectionName) {
      throw new Error(
        "CLOUD_SQL_INSTANCE_CONNECTION_NAME is required for the Cloud SQL backend"
      );
    }
    const iamAuth = process.env.CLOUD_SQL_IAM_AUTH !== "0";
    const serviceAccount = process.env.GCP_SERVICE_ACCOUNT_EMAIL;
    const user =
      process.env.DB_USER ||
      (iamAuth ? serviceAccount?.replace(/\.gserviceaccount\.com$/, "") : undefined);
    const password = process.env.DB_PASSWORD;
    const database = process.env.DB_NAME || "aistudio";
    if (!user || (!iamAuth && !password)) {
      throw new Error(
        "DB_USER is required, and DB_PASSWORD is required when CLOUD_SQL_IAM_AUTH=0"
      );
    }

    const connector = new Connector({ auth: getGoogleAuth() });
    const connectorOptions = await connector.getOptions({
      instanceConnectionName,
      authType: iamAuth ? AuthTypes.IAM : AuthTypes.PASSWORD,
      ipType:
        process.env.CLOUD_SQL_PRIVATE_IP === "1"
          ? IpAddressTypes.PRIVATE
          : IpAddressTypes.PUBLIC,
    });
    const pool = new pg.Pool({
      ...connectorOptions,
      user,
      ...(iamAuth ? {} : { password }),
      database,
      max: positiveInt(process.env.DB_POOL_MAX, 5),
      min: 0,
      idleTimeoutMillis: positiveInt(process.env.DB_IDLE_TIMEOUT_MS, 5000),
      connectionTimeoutMillis: positiveInt(
        process.env.DB_CONNECT_TIMEOUT_MS,
        10000
      ),
      allowExitOnIdle: true,
    });

    runtime.cloudSqlConnector = connector;
    runtime.cloudSqlPool = pool;
    return drizzleNodePg(pool, { schema }) as unknown as Database;
  }

  const connectionString =
    process.env.DATABASE_URL || "postgres://invalid:invalid@localhost:5432/none";
  const client = postgres(connectionString, {
    prepare: false,
    max: positiveInt(process.env.DB_POOL_MAX, 5),
    idle_timeout: positiveInt(process.env.DB_IDLE_TIMEOUT_SECONDS, 5),
    connect_timeout: positiveInt(process.env.DB_CONNECT_TIMEOUT_SECONDS, 10),
  });
  runtime.directClient = client;
  return drizzlePostgresJs(client, { schema });
}

/** Lazy so builds do not contact either Railway or Cloud SQL. */
export function getDb(): Promise<Database> {
  runtime.promise ??= createDatabase();
  return runtime.promise;
}

export { schema };
