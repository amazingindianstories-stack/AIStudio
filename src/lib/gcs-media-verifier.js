import { createHash } from "node:crypto";

export const CHECKPOINT_VERSION = 1;

export function positiveInt(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0
    ? Math.min(parsed, maximum)
    : fallback;
}

export function collectMediaKeys(value, keys = new Set()) {
  if (typeof value === "string") {
    const path = value.startsWith("/api/media/")
      ? value.slice("/api/media/".length)
      : null;
    if (path) keys.add(decodeURIComponent(path));
    return keys;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectMediaKeys(item, keys);
    return keys;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectMediaKeys(item, keys);
  }
  return keys;
}

export function fingerprintReferences(bucket, referencedKeys) {
  const hash = createHash("sha256");
  hash.update(`${bucket}\0`);
  for (const key of [...referencedKeys].sort()) hash.update(`${key}\0`);
  return hash.digest("hex");
}

export function newCheckpoint(bucket, referencedKeys) {
  const sortedKeys = [...referencedKeys].sort();
  return {
    version: CHECKPOINT_VERSION,
    bucket,
    fingerprint: fingerprintReferences(bucket, sortedKeys),
    referencedObjects: sortedKeys.length,
    referencedKeys: sortedKeys,
    nextPageToken: null,
    foundKeys: [],
    storedObjects: 0,
    pagesScanned: 0,
  };
}

export function assertCompatibleCheckpoint(checkpoint, bucket, referencedKeys) {
  const sortedKeys = [...referencedKeys].sort();
  if (
    checkpoint?.version !== CHECKPOINT_VERSION ||
    checkpoint?.bucket !== bucket ||
    checkpoint?.referencedObjects !== sortedKeys.length ||
    checkpoint?.fingerprint !== fingerprintReferences(bucket, sortedKeys) ||
    !Array.isArray(checkpoint?.referencedKeys) ||
    checkpoint.referencedKeys.length !== sortedKeys.length ||
    checkpoint.referencedKeys.some((key, index) => key !== sortedKeys[index]) ||
    !Array.isArray(checkpoint?.foundKeys)
  ) {
    throw new Error(
      "Verifier checkpoint does not match the current bucket/reference set; rerun with --reset"
    );
  }
}

/**
 * Scan bounded GCS listing pages and return a checkpoint after every page.
 * `listPage` returns { keys, nextPageToken }; it is injected for deterministic
 * tests and backed by Bucket#getFiles in the operational script.
 */
export async function scanBucketPages({
  referencedKeys,
  checkpoint,
  maxPages,
  listPage,
  saveCheckpoint = async () => {},
}) {
  const wanted = new Set(referencedKeys);
  const found = new Set(checkpoint.foundKeys);
  let pageToken = checkpoint.nextPageToken || undefined;
  let pagesThisRun = 0;
  let storedObjects = checkpoint.storedObjects;
  let pagesScanned = checkpoint.pagesScanned;

  do {
    if (pagesThisRun >= maxPages) {
      return {
        checkpoint: {
          ...checkpoint,
          nextPageToken: pageToken || null,
          foundKeys: [...found].sort(),
          storedObjects,
          pagesScanned,
        },
        complete: false,
      };
    }

    const page = await listPage(pageToken);
    const keys = page.keys || [];
    storedObjects += keys.length;
    for (const key of keys) {
      if (wanted.has(key)) found.add(key);
    }
    pageToken = page.nextPageToken || undefined;
    pagesThisRun++;
    pagesScanned++;

    checkpoint = {
      ...checkpoint,
      nextPageToken: pageToken || null,
      foundKeys: [...found].sort(),
      storedObjects,
      pagesScanned,
    };
    await saveCheckpoint(checkpoint);
  } while (pageToken);

  return { checkpoint, complete: true };
}

export function verificationResult(referencedKeys, checkpoint, complete) {
  const found = new Set(checkpoint.foundKeys);
  const missingKeys = complete
    ? referencedKeys.filter((key) => !found.has(key))
    : [];
  return {
    referencedObjects: referencedKeys.length,
    storedObjects: checkpoint.storedObjects,
    checked: complete ? referencedKeys.length : null,
    matchedReferencedObjects: checkpoint.foundKeys.length,
    missing: complete ? missingKeys.length : null,
    missingKeys,
    pagesScanned: checkpoint.pagesScanned,
    complete,
    nextPageToken: checkpoint.nextPageToken,
  };
}
