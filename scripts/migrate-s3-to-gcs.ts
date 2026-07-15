import { pipeline } from "node:stream/promises";
import { config } from "dotenv";
import {
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
  type _Object,
} from "@aws-sdk/client-s3";
import { Storage, type StorageOptions } from "@google-cloud/storage";
import { gcpProjectId, getStorageAuth } from "../src/lib/gcp-auth";

config({ path: process.env.ENV_FILE || ".env.local" });

const apply = process.argv.includes("--apply");
const verifyOnly = process.argv.includes("--verify-only");
const prefixArg = process.argv.find((arg) => arg.startsWith("--prefix="));
const prefix = prefixArg?.slice("--prefix=".length);

const sourceBucket = process.env.AWS_S3_BUCKET_NAME || "aistudio-media-bucket";
const targetBucket =
  process.env.GCP_MEDIA_BUCKET ||
  process.env.GCS_BUCKET_NAME ||
  "aistudio-media-bucket";

if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
  throw new Error("AWS credentials are required to read the source S3 bucket");
}

const s3 = new S3Client({
  region: process.env.AWS_REGION || "us-east-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});
const gcs = new Storage({
  projectId: gcpProjectId(),
  authClient: getStorageAuth() as unknown as StorageOptions["authClient"],
});

async function listSourceObjects(): Promise<_Object[]> {
  const objects: _Object[] = [];
  let continuationToken: string | undefined;
  do {
    const page = await s3.send(
      new ListObjectsV2Command({
        Bucket: sourceBucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      })
    );
    objects.push(...(page.Contents || []));
    continuationToken = page.NextContinuationToken;
  } while (continuationToken);
  return objects.filter((object) => !!object.Key);
}

async function inspect(object: _Object): Promise<"same" | "missing" | "different"> {
  const file = gcs.bucket(targetBucket).file(object.Key!);
  const [exists] = await file.exists();
  if (!exists) return "missing";
  const [metadata] = await file.getMetadata();
  return Number(metadata.size) === Number(object.Size) ? "same" : "different";
}

async function copy(object: _Object): Promise<void> {
  const source = await s3.send(
    new GetObjectCommand({ Bucket: sourceBucket, Key: object.Key! })
  );
  if (!source.Body) throw new Error(`S3 object ${object.Key} has no body`);
  const target = gcs.bucket(targetBucket).file(object.Key!);
  const output = target.createWriteStream({
    resumable: Number(object.Size) >= 8 * 1024 * 1024,
    contentType: source.ContentType || "application/octet-stream",
    metadata: {
      cacheControl:
        source.CacheControl || "public, max-age=31536000, immutable",
    },
    validation: "crc32c",
  });
  await pipeline(source.Body as NodeJS.ReadableStream, output);
}

async function run(): Promise<void> {
  const objects = await listSourceObjects();
  const totals = { same: 0, missing: 0, different: 0, copied: 0, failed: 0 };
  console.log(
    `${apply ? "Applying" : "Checking"} ${objects.length} objects: ` +
      `s3://${sourceBucket} -> gs://${targetBucket}`
  );

  for (const object of objects) {
    const state = await inspect(object);
    totals[state]++;
    if (state === "same" || verifyOnly || !apply) continue;
    try {
      await copy(object);
      const after = await inspect(object);
      if (after !== "same") throw new Error(`post-copy size mismatch (${after})`);
      totals.copied++;
      console.log(`copied ${object.Key}`);
    } catch (error) {
      totals.failed++;
      console.error(`failed ${object.Key}:`, error);
    }
  }

  console.log(JSON.stringify(totals, null, 2));
  if (totals.failed || (verifyOnly && (totals.missing || totals.different))) {
    process.exitCode = 1;
  }
  if (!apply && !verifyOnly) {
    console.log("Dry run only. Re-run with --apply to copy missing/different objects.");
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
