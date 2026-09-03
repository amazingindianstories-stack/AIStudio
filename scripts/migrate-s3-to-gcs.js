import { pipeline } from "node:stream/promises";
import { config } from "dotenv";
import {
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,

} from "@aws-sdk/client-s3";
import { Storage, } from "@google-cloud/storage";
import { gcpProjectId, getStorageCredentials } from "../src/lib/gcp-auth";

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
// Same construction as storage.js's own `storage()` — an `authClient` option
// here (this script's previous shape) doesn't exist on the Storage
// constructor at all; `credentials` is what actually wires WIF's raw
// external_account JSON through to the SDK's own nested google-auth-library
// (see gcp-auth.js's getStorageCredentials doc comment for why that
// specific shape matters). Locally / off Vercel this returns undefined and
// the client falls back to ambient ADC, same as storage.js.
const gcs = new Storage({
  projectId: gcpProjectId(),
  ...(getStorageCredentials() ? { credentials: getStorageCredentials() } : {}),
});

async function listSourceObjects() {
  const objects = [];
  let continuationToken;
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

async function listTargetObjects() {
  const [files] = await gcs.bucket(targetBucket).getFiles({ prefix });
  return new Map(
    files.map((file) => [file.name, Number(file.metadata.size)])
  );
}

function inspect(object, targetObjects) {
  const targetSize = targetObjects.get(object.Key);
  if (targetSize === undefined) return "missing";
  return targetSize === Number(object.Size) ? "same" : "different";
}

async function copy(object) {
  const source = await s3.send(
    new GetObjectCommand({ Bucket: sourceBucket, Key: object.Key })
  );
  if (!source.Body) throw new Error("S3 object has no body");
  const target = gcs.bucket(targetBucket).file(object.Key);
  const output = target.createWriteStream({
    resumable: Number(object.Size) >= 8 * 1024 * 1024,
    contentType: source.ContentType || "application/octet-stream",
    metadata: {
      cacheControl:
        source.CacheControl || "public, max-age=31536000, immutable",
    },
    validation: "crc32c",
  });
  await pipeline(source.Body , output);
}

async function run() {
  const [objects, targetObjects] = await Promise.all([
    listSourceObjects(),
    listTargetObjects(),
  ]);
  const totals = { same: 0, missing: 0, different: 0, copied: 0, failed: 0 };
  console.log(
    `${apply ? "Applying" : "Checking"} ${objects.length} objects: ` +
      `s3://${sourceBucket} -> gs://${targetBucket}`
  );

  const missingObjects = [];
  for (const object of objects) {
    const state = inspect(object, targetObjects);
    totals[state]++;
    if (state === "missing") missingObjects.push(object);
  }

  if (totals.different) {
    throw new Error(
      `Aborting: ${totals.different} size-different object(s) require manual review`
    );
  }

  if (apply && !verifyOnly) {
    for (const object of missingObjects) {
      try {
        await copy(object);
        const [metadata] = await gcs
          .bucket(targetBucket)
          .file(object.Key)
          .getMetadata();
        if (Number(metadata.size) !== Number(object.Size)) {
          throw new Error("post-copy size mismatch");
        }
        totals.copied++;
      } catch (error) {
        totals.failed++;
        console.error(
          "Copy failed; aborting without attempting later objects:",
          error
        );
        break;
      }
    }
  }

  console.log(JSON.stringify(totals, null, 2));
  if (totals.failed || (verifyOnly && totals.missing)) {
    process.exitCode = 1;
  }
  if (!apply && !verifyOnly) {
    console.log("Dry run only. Re-run with --apply to copy missing objects.");
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
