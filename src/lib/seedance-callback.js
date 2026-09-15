import { createHash, timingSafeEqual } from "node:crypto";

export const MAX_PROVIDER_TASK_ID_LENGTH = 256;

export function validHttpsUrl(value) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !!url.hostname ? url : undefined;
  } catch {
    return undefined;
  }
}

export function buildSeedanceCallbackUrl(base, secret) {
  const url = validHttpsUrl(base);
  if (!url || typeof secret !== "string" || !secret) return undefined;
  url.searchParams.set("token", secret);
  return url.toString();
}

export function callbackTokenMatches(supplied, expected) {
  if (typeof supplied !== "string" || typeof expected !== "string" || !expected) return false;
  const digest = (value) => createHash("sha256").update(value, "utf8").digest();
  return timingSafeEqual(digest(supplied), digest(expected));
}

export function extractProviderTaskId(payload) {
  const value = payload?.id ?? payload?.task_id ?? payload?.data?.id;
  if (typeof value !== "string") return undefined;
  const taskId = value.trim();
  if (!taskId || taskId.length > MAX_PROVIDER_TASK_ID_LENGTH) return undefined;
  return /^[A-Za-z0-9._:-]+$/.test(taskId) ? taskId : undefined;
}
