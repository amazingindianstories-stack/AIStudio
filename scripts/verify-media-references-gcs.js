import { config } from "dotenv";
import { execFile } from "node:child_process";
import { chmod, readFile, rename, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { Storage } from "@google-cloud/storage";
import postgres from "postgres";
import { gcpProjectId, getStorageCredentials } from "../src/lib/gcp-auth";
import {
  assertCompatibleCheckpoint,
  collectMediaKeys,
  newCheckpoint,
  positiveInt,
  scanBucketPages,
  verificationResult,
} from "../src/lib/gcs-media-verifier";

config({ path: process.env.ENV_FILE || ".env.local" });

if (process.argv.includes("--help")) {
  console.log(`Usage: npm run verify:media:gcp -- [options]

Options:
  --gcloud-auth       Use the local ADC token through gcloud (recommended locally)
  --checkpoint=PATH   Resume state path (default: /tmp/aistudio-gcs-verify-checkpoint.json)
  --max-pages=N       Maximum GCS pages this invocation (default: 10)
  --page-size=N       Objects per GCS page, capped at 1000 (default: 1000)
  --reset             Discard an existing checkpoint before scanning
  --keep-checkpoint   Retain the checkpoint after a complete scan
  --show-missing      Include up to 20 missing object names in output

Exit codes: 0 = complete/no gaps, 1 = complete/gaps or error, 2 = resumable page budget reached.`);
  process.exit(0);
}

const sourceUrl = process.env.DATABASE_URL;
if (!sourceUrl) throw new Error("DATABASE_URL is required");

const bucketName =
  process.env.GCP_MEDIA_BUCKET ||
  process.env.GCS_BUCKET_NAME ||
  "aistudio-media-bucket";
const checkpointArg = process.argv.find((arg) => arg.startsWith("--checkpoint="));
const maxPagesArg = process.argv.find((arg) => arg.startsWith("--max-pages="));
const pageSizeArg = process.argv.find((arg) => arg.startsWith("--page-size="));
const checkpointPath =
  checkpointArg?.slice("--checkpoint=".length) ||
  "/tmp/aistudio-gcs-verify-checkpoint.json";
const maxPages = positiveInt(
  maxPagesArg?.slice("--max-pages=".length) || process.env.GCS_VERIFY_MAX_PAGES,
  10,
  10_000
);
const pageSize = positiveInt(
  pageSizeArg?.slice("--page-size=".length) || process.env.GCS_VERIFY_PAGE_SIZE,
  1000,
  1000
);
const pageTimeoutSeconds = positiveInt(
  process.env.GCS_VERIFY_PAGE_TIMEOUT_SECONDS,
  30,
  600
);
const keepCheckpoint = process.argv.includes("--keep-checkpoint");
const resetCheckpoint = process.argv.includes("--reset");
const showMissing = process.argv.includes("--show-missing");
const useGcloudAuth = process.argv.includes("--gcloud-auth");
const execFileAsync = promisify(execFile);

const storageCredentials = useGcloudAuth ? undefined : getStorageCredentials();
const storage = useGcloudAuth
  ? null
  : new Storage({
      projectId: gcpProjectId(),
      ...(storageCredentials ? { credentials: storageCredentials } : {}),
      retryOptions: {
        autoRetry: true,
        maxRetries: 2,
        maxRetryDelay: 5,
        totalTimeout: pageTimeoutSeconds,
      },
    });

async function gcloudPageLoader() {
  const { stdout } = await execFileAsync(
    "gcloud",
    ["auth", "application-default", "print-access-token"],
    { timeout: 30_000 }
  );
  const accessToken = stdout.trim();
  if (!accessToken) throw new Error("gcloud returned an empty access token");

  return async (pageToken) => {
    const url = new URL(
      `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucketName)}/o`
    );
    url.searchParams.set("maxResults", String(pageSize));
    url.searchParams.set("fields", "items/name,nextPageToken");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(pageTimeoutSeconds * 1000),
    });
    if (!response.ok) {
      throw new Error(`GCS listing failed with HTTP ${response.status}`);
    }
    const body = await response.json();
    return {
      keys: (body.items || []).map((item) => item.name),
      nextPageToken: body.nextPageToken || null,
    };
  };
}

async function loadCheckpoint() {
  if (resetCheckpoint) await rm(checkpointPath, { force: true });
  try {
    const checkpoint = JSON.parse(await readFile(checkpointPath, "utf8"));
    assertCompatibleCheckpoint(checkpoint, bucketName, checkpoint.referencedKeys || []);
    return checkpoint;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function saveCheckpoint(checkpoint) {
  const temporaryPath = `${checkpointPath}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(checkpoint)}\n`, { mode: 0o600 });
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, checkpointPath);
}

async function loadReferencedKeys() {
  const sql = postgres(sourceUrl, {
    max: 1,
    prepare: false,
    connect_timeout: positiveInt(process.env.GCS_VERIFY_DB_TIMEOUT_SECONDS, 60, 600),
    idle_timeout: 5,
  });
  try {
    const [generations, assets, boards, users] = await Promise.all([
      sql`select url, poster, reference_images from generations`,
      sql`select images from assets`,
      sql`select data from canvas_boards`,
      sql`select avatar_url from users`,
    ]);
    const keys = collectMediaKeys([generations, assets, boards, users]);
    return [...keys].sort();
  } finally {
    await sql.end();
  }
}

async function run() {
  let checkpoint = await loadCheckpoint();
  const allKeys = checkpoint?.referencedKeys || (await loadReferencedKeys());
  if (!checkpoint) checkpoint = newCheckpoint(bucketName, allKeys);
  const bucket = storage?.bucket(bucketName);
  const listPage = useGcloudAuth
    ? await gcloudPageLoader()
    : async (pageToken) => {
        const [files, nextQuery] = await bucket.getFiles({
          autoPaginate: false,
          maxResults: pageSize,
          ...(pageToken ? { pageToken } : {}),
        });
        return {
          keys: files.map((file) => file.name),
          nextPageToken: nextQuery?.pageToken || null,
        };
      };
  const scan = await scanBucketPages({
    referencedKeys: allKeys,
    checkpoint,
    maxPages,
    listPage,
    saveCheckpoint,
  });
  const result = verificationResult(allKeys, scan.checkpoint, scan.complete);

  console.log(
    JSON.stringify(
      {
        bucket: bucketName,
        referencedObjects: result.referencedObjects,
        storedObjects: result.storedObjects,
        checked: result.checked,
        matchedReferencedObjects: result.matchedReferencedObjects,
        missing: result.missing,
        pagesScanned: result.pagesScanned,
        complete: result.complete,
        checkpoint: result.complete ? null : checkpointPath,
        ...(showMissing && result.complete
          ? { missingSample: result.missingKeys.slice(0, 20) }
          : {}),
      },
      null,
      2
    )
  );
  if (scan.complete && !keepCheckpoint) await rm(checkpointPath, { force: true });
  if (!scan.complete) {
    console.error(
      `Page budget reached; rerun the same command to resume from ${checkpointPath}`
    );
    process.exitCode = 2;
  } else if (result.missing) {
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
