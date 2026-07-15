import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "dotenv";
import postgres from "postgres";

config({ path: process.env.ENV_FILE || ".env.local" });

const sourceUrl = process.env.DATABASE_URL;
if (!sourceUrl) throw new Error("DATABASE_URL is required");

const bucketName =
  process.env.GCP_MEDIA_BUCKET ||
  process.env.GCS_BUCKET_NAME ||
  "aistudio-media-bucket";
const execFileAsync = promisify(execFile);

function collectMediaKeys(value: unknown, keys: Set<string>): void {
  if (typeof value === "string") {
    const path = value.startsWith("/api/media/")
      ? value.slice("/api/media/".length)
      : null;
    if (path) keys.add(decodeURIComponent(path));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectMediaKeys(item, keys);
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectMediaKeys(item, keys);
  }
}

async function run(): Promise<void> {
  const sql = postgres(sourceUrl!, { max: 1, prepare: false });
  try {
    const [generations, assets, boards, users] = await Promise.all([
      sql`select url, poster, reference_images from generations`,
      sql`select images from assets`,
      sql`select data from canvas_boards`,
      sql`select avatar_url from users`,
    ]);
    const keys = new Set<string>();
    collectMediaKeys(generations, keys);
    collectMediaKeys(assets, keys);
    collectMediaKeys(boards, keys);
    collectMediaKeys(users, keys);

    const allKeys = [...keys].sort();
    const { stdout } = await execFileAsync("gcloud", [
      "storage",
      "ls",
      "--recursive",
      `gs://${bucketName}`,
    ]);
    const prefix = `gs://${bucketName}/`;
    const storedKeys = new Set(
      stdout
        .split("\n")
        .filter((line) => line.startsWith(prefix) && !line.endsWith("/"))
        .map((line) => line.slice(prefix.length))
    );
    const missing = allKeys.filter((key) => !storedKeys.has(key));

    console.log(
      JSON.stringify(
        {
          bucket: bucketName,
          referencedObjects: allKeys.length,
          storedObjects: storedKeys.size,
          checked: allKeys.length,
          missing: missing.length,
          missingSample: missing.slice(0, 20),
        },
        null,
        2
      )
    );
    if (missing.length) process.exitCode = 1;
  } finally {
    await sql.end();
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
