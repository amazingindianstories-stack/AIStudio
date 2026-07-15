import { config } from "dotenv";
import { spawn } from "node:child_process";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

config({ path: process.env.ENV_FILE || ".env.local" });

const apply = process.argv.includes("--apply");
const project = process.env.GCP_PROJECT_ID || "ais-project-for-gcp";
const instance = process.env.CLOUD_SQL_INSTANCE || "aistudio-db";
const database = process.env.DB_NAME || "aistudio";
const migrationBucket = process.env.GCP_MEDIA_BUCKET || "aistudio-media-bucket";
const sourceUrl = process.env.DATABASE_URL;
const runtimeIamUser =
  process.env.CLOUD_SQL_IAM_DB_USER ||
  process.env.GCP_SERVICE_ACCOUNT_EMAIL?.replace(/\.gserviceaccount\.com$/, "") ||
  "aistudio-media-sa@ais-project-for-gcp.iam";

if (!sourceUrl) throw new Error("DATABASE_URL is required for the Railway source");

function run(command: string, args: string[], env = process.env): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`))
    );
  });
}

function quoteIdent(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function postImportSql(): string {
  const runtimeRole = quoteIdent(runtimeIamUser);

  return `

-- Codex post-import hardening for Cloud SQL runtime access and query paths.
GRANT CONNECT ON DATABASE "aistudio" TO ${runtimeRole};
GRANT USAGE ON SCHEMA "public" TO ${runtimeRole};
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "public" TO ${runtimeRole};
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "public" TO ${runtimeRole};
ALTER DEFAULT PRIVILEGES FOR ROLE "cloudsqlsuperuser" IN SCHEMA "public" GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${runtimeRole};
ALTER DEFAULT PRIVILEGES FOR ROLE "cloudsqlsuperuser" IN SCHEMA "public" GRANT USAGE, SELECT ON SEQUENCES TO ${runtimeRole};

CREATE INDEX IF NOT EXISTS "generations_created_at_idx" ON "generations" ("created_at");
CREATE INDEX IF NOT EXISTS "generations_queue_idx" ON "generations" ("status", "kind", "created_at");
CREATE INDEX IF NOT EXISTS "generations_project_id_idx" ON "generations" ("project_id");
CREATE INDEX IF NOT EXISTS "generations_folder_id_idx" ON "generations" ("folder_id");
CREATE INDEX IF NOT EXISTS "generations_user_created_idx" ON "generations" ("user_id", "created_at");
CREATE INDEX IF NOT EXISTS "canvas_boards_project_id_idx" ON "canvas_boards" ("project_id");
CREATE INDEX IF NOT EXISTS "activity_logs_created_at_idx" ON "activity_logs" ("created_at");

ANALYZE;
`;
}

async function runAllowingAlreadyExists(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "inherit", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      process.stderr.write(chunk);
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0 || /already exists/i.test(stderr)) resolve();
      else reject(new Error(`${command} exited with ${code}`));
    });
  });
}

async function main(): Promise<void> {
  const workdir = await mkdtemp(path.join(tmpdir(), "lumina-cloud-sql-"));
  try {
    const dump = path.join(workdir, "railway.sql");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const object = `gs://${migrationBucket}/migrations/railway-${stamp}.sql`;

    console.log(`Creating consistent Railway snapshot at ${dump}`);
    await run("pg_dump", [
      `--dbname=${sourceUrl}`,
      "--format=plain",
      "--clean",
      "--if-exists",
      "--no-owner",
      "--no-acl",
      "--quote-all-identifiers",
      `--file=${dump}`,
    ]);
    await appendFile(dump, postImportSql());

    if (!apply) {
      console.log(
        "Snapshot complete. Dry run only; pass --apply to upload and import it."
      );
      return;
    }

    await runAllowingAlreadyExists("gcloud", [
      "sql",
      "databases",
      "create",
      database,
      `--instance=${instance}`,
      `--project=${project}`,
    ]);
    await run("gcloud", ["storage", "cp", dump, object]);
    await run("gcloud", [
      "sql",
      "import",
      "sql",
      instance,
      object,
      `--database=${database}`,
      `--project=${project}`,
      "--quiet",
    ]);
    console.log(
      `Imported Railway snapshot into ${project}:${instance}/${database}`
    );
    console.log(`Audit copy retained at ${object}`);
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
