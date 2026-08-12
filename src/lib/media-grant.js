import { createHmac, timingSafeEqual } from "crypto";

/**
 * Short-lived, HMAC-signed permission to read ONE stored object without a
 * session — so an external provider can fetch it.
 *
 * Why this exists rather than a cloud presigned URL: this deployment
 * authenticates to GCS by Workload Identity Federation, which has no signing
 * key, so `file.getSignedUrl()` cannot work at all (confirmed in production
 * 2026-07-29). The alternatives both need infrastructure changes — make the
 * bucket public behind a CDN, or set up service-account impersonation for IAM
 * signBlob — and the first of those would undo the access control that
 * `/api/media/[...path]` exists to enforce.
 *
 * This grant is deliberately narrower than either:
 *  - one object, named in the signature, so a grant cannot be widened;
 *  - short TTL, so a leaked URL stops working;
 *  - read-only, and refuses the `settings/` and `migrations/` prefixes that
 *    share this bucket, matching the media route's denylist;
 *  - signed with AUTH_SECRET, so grants die when that is rotated.
 *
 * It costs us the egress the cloud would otherwise have served directly. For a
 * handful of reference clips per generation that is a fair trade for not
 * making the bucket public.
 */

/** Prefixes that must never be reachable, matching the media route. */
const GRANT_DENY = /^(settings|migrations)\//i;

const DEFAULT_TTL_SECONDS = 15 * 60;

function secret() {
  const value = process.env.AUTH_SECRET;
  if (value) return value;
  if (process.env.NODE_ENV === "production") {
    throw new Error("AUTH_SECRET is required in production.");
  }
  return "dev-insecure-secret-change-me";
}

function sign(payload) {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

/** Mint a grant token for one object key. */
export function signMediaGrant(key, ttlSeconds = DEFAULT_TTL_SECONDS) {
  if (GRANT_DENY.test(key)) {
    throw new Error(`Refusing to grant access to a protected prefix: ${key}`);
  }
  const exp = Date.now() + ttlSeconds * 1000;
  const payload = `${Buffer.from(key).toString("base64url")}.${exp}`;
  return `${payload}.${sign(payload)}`;
}

/** Verify a grant token, returning the key it authorises, or null. */
export function verifyMediaGrant(token) {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [encodedKey, expRaw, sig] = parts;

  const expected = sign(`${encodedKey}.${expRaw}`);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  // Constant-time, and length-checked first because timingSafeEqual throws on
  // a length mismatch rather than returning false.
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || Date.now() > exp) return null;

  let key;
  try {
    key = Buffer.from(encodedKey, "base64url").toString("utf8");
  } catch {
    return null;
  }
  // Re-checked on the way out: the denylist must hold even for a token that
  // was somehow minted before the prefix was protected.
  if (!key || GRANT_DENY.test(key)) return null;
  return key;
}

/**
 * Absolute origin for grant URLs. A provider fetches these from its own
 * network, so a relative path is useless — and getting this wrong fails at the
 * provider rather than here, so it throws loudly instead of guessing.
 */
export function appOrigin() {
  const explicit = process.env.PUBLIC_APP_URL || process.env.NEXT_PUBLIC_APP_URL;
  if (explicit) return explicit.replace(/\/$/, "");
  const vercel =
    process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
  if (vercel) return `https://${vercel.replace(/\/$/, "")}`;
  throw new Error(
    "No public origin is configured, so a reference clip cannot be given a URL " +
      "the provider can fetch. Set PUBLIC_APP_URL (e.g. https://veevee.ai)."
  );
}

/** Full, provider-fetchable URL for one stored object. */
export function mediaGrantUrl(key, ttlSeconds) {
  return `${appOrigin()}/api/media-grant?t=${encodeURIComponent(
    signMediaGrant(key, ttlSeconds)
  )}`;
}
