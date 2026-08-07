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
  /** When the cached Cloud SQL connector/pool was built (ms). */
  cloudSqlBuiltAt?: number;
}

const globalForDb = globalThis as unknown as { __veeveeDb?: DbRuntime };
const runtime = globalForDb.__veeveeDb ?? {};
globalForDb.__veeveeDb = runtime;

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

    // Belt and braces alongside the age-based recycle in `getDb()`: if a stale
    // certificate still slips through, surface it as a rebuild rather than
    // letting every request fail until the instance is replaced.
    pool.on("error", (error: Error) => {
      if (/certificate|SSL/i.test(String(error?.message))) recycleCloudSql();
    });

    runtime.cloudSqlConnector = connector;
    runtime.cloudSqlPool = pool;
    runtime.cloudSqlBuiltAt = Date.now();
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

/**
 * How long a cached Cloud SQL connector/pool may be reused before it is rebuilt.
 *
 * The connector authenticates with a short-lived (~1 hour) ephemeral client
 * certificate and refreshes it on a BACKGROUND TIMER. On Vercel the instance is
 * frozen between requests, so that timer never fires: the certificate silently
 * goes stale and every subsequent connection is rejected by Cloud SQL with
 * `SSL alert 42 (bad certificate)`. This took production down on 2026-07-27
 * after ~3.5h of healthy operation — see .council/gcp-migration-holdoff.md.
 *
 * Upstream tracks lazy/on-demand refresh as an open P1 feature request
 * (GoogleCloudPlatform/cloud-sql-nodejs-connector#285), so until that ships we
 * age out the connector ourselves. The check below runs on the REQUEST path
 * rather than a timer, which is what makes it survive a frozen instance: an
 * instance thawed after hours sees a stale age on its very next request and
 * rebuilds before connecting.
 *
 * Keep this comfortably under the ~60 min certificate lifetime.
 */
const CLOUD_SQL_MAX_AGE_MS = positiveInt(
  process.env.CLOUD_SQL_RECYCLE_MS,
  30 * 60_000
);

/** Drop the cached Cloud SQL connector/pool so the next call rebuilds it. */
function recycleCloudSql(): void {
  const { cloudSqlPool: pool, cloudSqlConnector: connector } = runtime;
  runtime.promise = undefined;
  runtime.cloudSqlPool = undefined;
  runtime.cloudSqlConnector = undefined;
  runtime.cloudSqlBuiltAt = undefined;
  // Best effort teardown: `end()` drains in-flight queries, and neither call
  // may reject into the request path that triggered the recycle.
  void pool?.end().catch(() => {});
  try {
    connector?.close();
  } catch {
    // already closed
  }
}

/** Lazy so builds do not contact either Railway or Cloud SQL. */
export function getDb(): Promise<Database> {
  if (
    process.env.DATABASE_BACKEND === "cloud-sql" &&
    runtime.promise &&
    runtime.cloudSqlBuiltAt !== undefined &&
    Date.now() - runtime.cloudSqlBuiltAt > CLOUD_SQL_MAX_AGE_MS
  ) {
    recycleCloudSql();
  }
  runtime.promise ??= createDatabase();
  return runtime.promise;
}

export { schema };
