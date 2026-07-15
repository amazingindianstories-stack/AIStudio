/**
 * Admin "Status" tab — live health checks for every external dependency the
 * app relies on (4 generation providers + Postgres + media storage). See
 * `.council/admin-status-page/design.md` for the full contract this module
 * implements; this file is the single source of truth for check logic.
 *
 * Hard safety constraint (design.md §6.2, §12-R1): the Higgsfield check may
 * ONLY call `loadToken()`/`isFresh()` — it must never trigger a refresh-token
 * exchange (`accessToken()`/`refreshToken()`/`callTool()`/`refreshOnce()` are
 * off-limits here). Refresh tokens are single-use and reuse revokes the whole
 * token family with no automated recovery.
 *
 * Postgres and storage checks go through the backend-agnostic `getDb()`/
 * `checkStorageConnectivity()` accessors (src/lib/db.ts, src/lib/storage.ts)
 * rather than hardcoding a specific backend, so this stays correct across
 * the Railway->Cloud SQL and S3->GCS migration without needing an update
 * when either `DATABASE_BACKEND`/`MEDIA_BACKEND` flag flips.
 */
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { checkStorageConnectivity } from "@/lib/storage";
import { loadToken, isFresh } from "@/lib/providers/higgsfield-mcp";

export type CheckStatus = "ok" | "error" | "unknown";

/** One dependency's health result. */
export interface CheckResult {
  id: string; // stable machine key, e.g. "gemini" | "higgsfield" | "postgres"
  name: string; // display label, e.g. "Gemini / Nano Banana Pro"
  status: CheckStatus;
  detail: string; // short human string: HTTP code, latency note, or error message
  latencyMs: number; // wall-clock time this check took (>= 0)
  checkedAt: number; // Date.now() ms when this check finished
}

/** The whole-batch response. `checks` is always length 6, in registry order. */
export interface StatusResponse {
  checkedAt: number; // Date.now() ms when the batch started
  checks: CheckResult[];
}

/** What an individual check returns; the wrapper adds id/name/latency/checkedAt. */
type CheckOutcome = { status: CheckStatus; detail: string };

/** A check receives an AbortSignal (wired to the timeout) and must not throw for
 *  config-absence cases — it returns { status: "unknown", ... } instead. It MAY
 *  throw on genuine failures; runCheck catches those into an "error" result. */
type CheckFn = (signal: AbortSignal) => Promise<CheckOutcome>;

interface CheckDef {
  id: string;
  name: string;
  fn: CheckFn;
}

const CHECK_TIMEOUT_MS = 5000;

// mirrors gemini.ts (API_ROOT / MODEL) — duplicated rather than exported, per
// the "only Higgsfield gets an export change" rule (design.md §10)
const GEMINI_API_ROOT = "https://generativelanguage.googleapis.com/v1beta";
const GEMINI_MODEL = "gemini-3-pro-image";

// ── 6.1 gemini — Gemini / Nano Banana Pro (LIVE metadata call) ─────────────
async function checkGemini(signal: AbortSignal): Promise<CheckOutcome> {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) return { status: "unknown", detail: "GOOGLE_API_KEY not set" };
  const res = await fetch(`${GEMINI_API_ROOT}/models/${GEMINI_MODEL}`, {
    headers: { "x-goog-api-key": apiKey },
    signal,
  });
  if (res.ok) return { status: "ok", detail: "HTTP 200" };
  return { status: "error", detail: `HTTP ${res.status}` };
}

// ── 6.2 higgsfield — Higgsfield MCP (READ-ONLY, D0 constraint) ─────────────
async function checkHiggsfield(): Promise<CheckOutcome> {
  try {
    const t = await loadToken(); // reads storage backend/env/file; no refresh
    if (isFresh(t)) return { status: "ok", detail: "Cached access token fresh" };
    return {
      status: "unknown",
      detail: "Token present but access token not fresh — refresh not triggered",
    };
  } catch {
    return {
      status: "unknown",
      detail: "No Higgsfield token found (storage backend/env/local file)",
    };
  }
}

// ── 6.3 seedance — BytePlus ModelArk / Seedance (CONFIG-PRESENCE) ──────────
export async function checkSeedance(): Promise<CheckOutcome> {
  if (process.env.ARK_API_KEY) {
    return { status: "ok", detail: "ARK_API_KEY set (config-presence only)" };
  }
  return { status: "unknown", detail: "ARK_API_KEY not set" };
}

// ── 6.4 omni — Gemini Omni Flash (CONFIG-PRESENCE) ─────────────────────────
export async function checkOmni(): Promise<CheckOutcome> {
  if (process.env.OMNI_USE_VERTEX === "1") {
    if (process.env.GOOGLE_CLOUD_PROJECT) {
      return { status: "ok", detail: "Vertex configured (config-presence only)" };
    }
    return {
      status: "unknown",
      detail: "OMNI_USE_VERTEX=1 but GOOGLE_CLOUD_PROJECT not set",
    };
  }
  if (process.env.GOOGLE_API_KEY) {
    return {
      status: "ok",
      detail: "generativelanguage configured (config-presence only)",
    };
  }
  return { status: "unknown", detail: "GOOGLE_API_KEY not set" };
}

// ── 6.5 postgres ───────────────────────────────────────────────────────────
async function checkPostgres(): Promise<CheckOutcome> {
  const db = await getDb();
  await db.execute(sql`select 1`);
  return { status: "ok", detail: "select 1 ok" };
}

// ── 6.6 storage — active media backend (S3 or GCS, per MEDIA_BACKEND) ──────
async function checkStorage(): Promise<CheckOutcome> {
  const detail = await checkStorageConnectivity();
  return { status: "ok", detail: `${detail} reachable` };
}

/** The six checks, in the fixed display order. Exported for test injection. */
export const CHECKS: CheckDef[] = [
  { id: "gemini", name: "Gemini / Nano Banana Pro", fn: checkGemini },
  { id: "higgsfield", name: "Higgsfield MCP", fn: checkHiggsfield },
  { id: "seedance", name: "BytePlus ModelArk / Seedance", fn: checkSeedance },
  { id: "omni", name: "Gemini Omni Flash", fn: checkOmni },
  { id: "postgres", name: "Postgres", fn: checkPostgres },
  { id: "storage", name: "Media Storage", fn: checkStorage },
];

class TimeoutError extends Error {}

/** Wrap one check: measure latency, enforce the timeout, never reject. */
export async function runCheck(
  def: CheckDef,
  timeoutMs: number = CHECK_TIMEOUT_MS
): Promise<CheckResult> {
  const start = Date.now();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new TimeoutError());
    }, timeoutMs);
  });
  try {
    const outcome = await Promise.race([def.fn(controller.signal), timeout]);
    return {
      ...outcome,
      id: def.id,
      name: def.name,
      latencyMs: Date.now() - start,
      checkedAt: Date.now(),
    };
  } catch (err) {
    const detail =
      err instanceof TimeoutError
        ? `Timed out after ${timeoutMs}ms`
        : err instanceof Error
          ? err.message
          : String(err);
    return {
      id: def.id,
      name: def.name,
      status: "error",
      detail,
      latencyMs: Date.now() - start,
      checkedAt: Date.now(),
    };
  } finally {
    clearTimeout(timer!);
  }
}

/** Run every check in `checks` in parallel and assemble the response.
 *  `checks` defaults to CHECKS; the parameter exists purely as a test seam. */
export async function runAllChecks(
  checks: CheckDef[] = CHECKS,
  timeoutMs: number = CHECK_TIMEOUT_MS
): Promise<StatusResponse> {
  const checkedAt = Date.now();
  const settled = await Promise.allSettled(checks.map((d) => runCheck(d, timeoutMs)));
  const results = settled.map((s, i) =>
    s.status === "fulfilled"
      ? s.value
      : {
          id: checks[i].id,
          name: checks[i].name,
          status: "error" as const,
          detail: "internal check error",
          latencyMs: 0,
          checkedAt: Date.now(),
        }
  );
  return { checkedAt, checks: results };
}
