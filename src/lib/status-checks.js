/**
 * Admin "Status" tab — live health checks for every external dependency the
 * app relies on: 5 generation providers (Gemini/NBP, Higgsfield, Seedance,
 * Kling, Omni) + Postgres + generation indexes + stuck jobs + media storage
 * + media delivery mode + ffmpeg runtime, 11 checks
 * total (see CHECKS below — this count drifted out of sync with the actual
 * array once before; if you add or remove a check, update this number too).
 * See `.council/admin-status-page/design.md` for the full contract this
 * module implements; this file is the single source of truth for check
 * logic.
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
import { desc, eq, sql } from "drizzle-orm";
import { execFile } from "node:child_process";
import ffmpegPath from "@ffmpeg-installer/ffmpeg";
import { getDb } from "@/lib/db";
import {
  browserMediaUrl,
  checkStorageConnectivity,
  mediaKeyFromRef,
} from "@/lib/storage";
import { generations } from "@/lib/schema";
import { loadToken, isFresh } from "@/lib/providers/higgsfield-mcp";
import {
  checkGenerationIndexes as inspectGenerationIndexes,
  checkStuckGenerations as inspectStuckGenerations,
} from "@/lib/generation-health";

 

const CHECK_TIMEOUT_MS = 5000;

// mirrors gemini.ts (API_ROOT / MODEL) — duplicated rather than exported, per
// the "only Higgsfield gets an export change" rule (design.md §10)
const GEMINI_API_ROOT = "https://generativelanguage.googleapis.com/v1beta";
const GEMINI_MODEL = "gemini-3-pro-image";

// ── 6.1 gemini — Gemini / Nano Banana Pro (LIVE metadata call) ─────────────
async function checkGemini(signal) {
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
async function checkHiggsfield() {
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
export async function checkSeedance() {
  if (process.env.ARK_API_KEY) {
    return { status: "ok", detail: "ARK_API_KEY set (config-presence only)" };
  }
  return { status: "unknown", detail: "ARK_API_KEY not set" };
}

// ── 6.3b kling — KlingAI image models (CONFIG-PRESENCE) ────────────────────
// Config-presence only, like its neighbours. Kling *does* have a free
// read-only task-list endpoint that would prove the key is live, but every
// other provider check here is deliberately offline so opening the Status tab
// can never cost money or consume a rate limit; one live check would make the
// tab's behaviour inconsistent. Use scripts/probe-kling-image.ts to verify the
// key for real.
export async function checkKling() {
  if (process.env.KLING_API) {
    return { status: "ok", detail: "KLING_API set (config-presence only)" };
  }
  return { status: "unknown", detail: "KLING_API not set" };
}

// ── 6.4 omni — Gemini Omni Flash (CONFIG-PRESENCE) ─────────────────────────
export async function checkOmni() {
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
async function checkPostgres() {
  const db = await getDb();
  await db.execute(sql`select 1`);
  return { status: "ok", detail: "select 1 ok" };
}

async function checkGenerationIndexes() {
  return inspectGenerationIndexes();
}

async function checkStuckGenerations() {
  return inspectStuckGenerations();
}

// ── 6.6 storage — active media backend (S3 or GCS, per MEDIA_BACKEND) ──────
async function checkStorage() {
  const detail = await checkStorageConnectivity();
  return { status: "ok", detail: `${detail} reachable` };
}

function ffmpegVersion(signal) {
  return new Promise((resolve, reject) => {
    execFile(
      ffmpegPath.path,
      ["-version"],
      { timeout: 3000, maxBuffer: 256 * 1024, signal },
      (error, stdout) => {
        if (error) return reject(error);
        resolve(String(stdout));
      }
    );
  });
}

export async function checkFfmpeg(signal) {
  const output = await ffmpegVersion(signal);
  const firstLine = output.split("\n", 1)[0];
  if (!/^ffmpeg version\s+/i.test(firstLine)) {
    return { status: "error", detail: "ffmpeg executable returned an unexpected response" };
  }
  return { status: "ok", detail: firstLine.slice(0, 160) };
}

/**
 * Whether media can be handed to the browser directly rather than proxied
 * through `/api/media`.
 *
 * This is the one thing about the media path that cannot be established from
 * config alone and cannot be exercised from a laptop: signing runs through IAM
 * `signBlob` using the Workload Identity Federation credentials, which only
 * exist inside a production/preview deploy. When it fails the route silently
 * (and correctly) falls back to proxying bytes — which is exactly the state
 * that produced the 2026-08-04 timeout alert — so it needs to be visible rather
 * than inferred from a latency graph.
 *
 * The probe reads at most one byte of existing user media and never logs its
 * object key or URL. It creates no generation and makes no provider call.
 */
async function checkMediaDelivery(signal) {
  const db = await getDb();
  const candidates = await db
    .select({ url: generations.url, poster: generations.poster })
    .from(generations)
    .where(eq(generations.status, "succeeded"))
    .orderBy(desc(generations.updatedAt))
    .limit(20);
  const key = candidates
    .flatMap((row) => [row.url, row.poster])
    .filter(Boolean)
    .map(mediaKeyFromRef)
    .find(Boolean);
  if (!key) {
    return { status: "unknown", detail: "No recent stored media is available for a read probe" };
  }
  const directUrl = await browserMediaUrl(key);
  if (!directUrl) {
    return {
      status: "error",
      detail: "Browser delivery fell back to proxying bytes through the function",
    };
  }
  const response = await fetch(directUrl, {
    method: "GET",
    headers: { Range: "bytes=0-0" },
    signal,
  });
  await response.body?.cancel().catch(() => {});
  if (response.status !== 200 && response.status !== 206) {
    return { status: "error", detail: `Direct browser media read returned HTTP ${response.status}` };
  }
  return {
    status: "ok",
    detail: `Direct browser media read succeeded (HTTP ${response.status}; object identity redacted)`,
  };
}

/** The eleven checks, in the fixed display order. Exported for test injection. */
export const CHECKS = [
  { id: "gemini", name: "Gemini / Nano Banana Pro", fn: checkGemini },
  { id: "higgsfield", name: "Higgsfield MCP", fn: checkHiggsfield },
  { id: "seedance", name: "BytePlus ModelArk / Seedance", fn: checkSeedance },
  { id: "kling", name: "KlingAI Image", fn: checkKling },
  { id: "omni", name: "Gemini Omni Flash", fn: checkOmni },
  { id: "postgres", name: "Postgres", fn: checkPostgres },
  { id: "generation-indexes", name: "Generation Indexes", fn: checkGenerationIndexes },
  { id: "stuck-generations", name: "Stuck Generations", fn: checkStuckGenerations },
  { id: "storage", name: "Media Storage", fn: checkStorage },
  { id: "ffmpeg-runtime", name: "ffmpeg Runtime", fn: checkFfmpeg },
  { id: "media-delivery", name: "Media Delivery", fn: checkMediaDelivery },
];

class TimeoutError extends Error {}

/** Wrap one check: measure latency, enforce the timeout, never reject. */
export async function runCheck(
  def,
  timeoutMs = CHECK_TIMEOUT_MS
) {
  const start = Date.now();
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
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
    clearTimeout(timer);
  }
}

/** Run every check in `checks` in parallel and assemble the response.
 *  `checks` defaults to CHECKS; the parameter exists purely as a test seam. */
export async function runAllChecks(
  checks = CHECKS,
  timeoutMs = CHECK_TIMEOUT_MS
) {
  const checkedAt = Date.now();
  const settled = await Promise.allSettled(checks.map((d) => runCheck(d, timeoutMs)));
  const results = settled.map((s, i) =>
    s.status === "fulfilled"
      ? s.value
      : {
          id: checks[i].id,
          name: checks[i].name,
          status: "error" ,
          detail: "internal check error",
          latencyMs: 0,
          checkedAt: Date.now(),
        }
  );
  return { checkedAt, checks: results };
}
