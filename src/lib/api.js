// Browser requests stay same-origin; Next transports /api directly to Django.
export const API_BASE = "";

export function apiUrl(path) {
  if (typeof path !== "string" || !path.startsWith("/api/") || path.includes("\\")) {
    throw new Error("API requests require a same-origin /api/ path");
  }
  const normalized = new URL(path, "https://same-origin.invalid");
  if (!normalized.pathname.startsWith("/api/") || normalized.pathname !== path.split(/[?#]/, 1)[0]) {
    throw new Error("API path must not traverse outside its endpoint");
  }
  return path;
}

export function apiFetch(path, options = {}) {
  return fetch(apiUrl(path), { credentials: "include", ...options });
}

export const CAPACITY_BUSY_CODE = "SLOW_REQUEST_CAPACITY_BUSY";
const BUSY_MAX_WAIT_MS = 30000;
const BUSY_MAX_DELAY_MS = 5000;

async function isCapacityBusy(res) {
  if (res.status !== 429) return false;
  try {
    return (await res.clone().json())?.error === CAPACITY_BUSY_CODE;
  } catch {
    return false;
  }
}

/**
 * Re-sends a request the API turned away with SLOW_REQUEST_CAPACITY_BUSY. The
 * server answers that 429 before doing any work (no job, upload or spend), so
 * repeating is always safe; generation submits also carry an Idempotency-Key.
 * Waits Retry-After with growing, jittered delays for up to maxWaitMs, then
 * returns the last response so the caller reports it. Any other response,
 * including other 429s such as upload quota, is returned untouched.
 */
export async function retryWhileBusy(send, { maxWaitMs = BUSY_MAX_WAIT_MS, signal, sleep, random = Math.random, now = Date.now } = {}) {
  const wait = sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const started = now();
  for (let attempt = 0; ; attempt += 1) {
    const res = await send();
    if (signal?.aborted || !(await isCapacityBusy(res))) return res;
    const retryAfter = Number(res.headers.get("Retry-After"));
    const base = (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 1) * 1000;
    const delay = Math.min(base * 1.5 ** attempt, BUSY_MAX_DELAY_MS) * (0.75 + random() * 0.5);
    if (now() - started + delay > maxWaitMs) return res;
    await wait(delay);
  }
}

export function apiFetchRetryBusy(path, options = {}, retry) {
  return retryWhileBusy(() => apiFetch(path, options), { signal: options.signal, ...retry });
}

export function fetchRetryBusy(url, options = {}, retry) {
  return retryWhileBusy(() => fetch(url, options), { signal: options.signal, ...retry });
}
