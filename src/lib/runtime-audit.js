import { randomUUID } from "node:crypto";
import { access, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { count, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "./db";
import { signSession, SESSION_COOKIE } from "./auth";
import { generations, userLimits, users } from "./schema";
import {
  expectedKlingResolutionPass,
  expectedKlingRoutingPass,
  runKlingValidation,
  summarizeKlingMatrix,
} from "./kling-validation";
import { generateAndSpoolCandidates, readSpooledBase64 } from "./best-of-spool";
import { abortableDelay, settleQueueExecution } from "./queue-execution-deadline";

const CHECK_IDS = [
  "MIG-04", "ARCH-03", "QUAL-03", "ARCH-04", "VER-08", "VER-10",
  "REL-02", "REL-03",
];

export function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted && ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
    else if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === ",") { row.push(cell); cell = ""; }
    else if (!quoted && (ch === "\n" || ch === "\r")) {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

export function sanitizeAuditDetail(value) {
  const text = String(value ?? "check failed").replace(/[\r\n]+/g, " ").slice(0, 180);
  return text
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, "[redacted]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/((?:api[_-]?key|secret|password|token))\s*[=:]\s*\S+/gi, "$1=[redacted]");
}

export function activeDatabaseBackend(value = process.env.DATABASE_BACKEND) {
  return value === "cloud-sql" ? "cloud-sql" : "direct-postgres";
}

function result(id, status, detail) {
  return { id, status, detail: sanitizeAuditDetail(detail) };
}

export function klingAuditResults(kling) {
  if (!kling.noTaskCreated) {
    const safety = kling.requestSafetyPass
      ? "task-list stability could not be proven"
      : "one or more requests did not reject safely";
    return [
      result("ARCH-04", "error", `no-task invariant failed: ${safety}`),
      result("VER-08", "error", `no-task invariant failed: ${safety}`),
      result("VER-10", "unknown", "seed verdict suppressed because the no-task invariant failed"),
    ];
  }
  const summary = summarizeKlingMatrix(kling.matrix);
  const routingPass = expectedKlingRoutingPass(kling.matrix);
  const resolutionPass = expectedKlingResolutionPass(kling.matrix);
  return [
    result("ARCH-04", routingPass ? "ok" : "error",
      `${summary.routingPassed}/${summary.routingTotal} registered wire models reached safe validation; no task was created`),
    result("VER-08", !routingPass ? "unknown" : resolutionPass ? "ok" : "error",
      !routingPass
        ? "resolution verdict suppressed because registered wire-model routing failed; no task was created"
        : `${summary.resolutionPassed}/${summary.resolutionTotal} live 1K/2K text/reference cases matched configured capabilities; no task was created`),
    result("VER-10", kling.seedVerdict === "inconclusive" ? "unknown" : "ok",
      kling.seedVerdict === "inconclusive"
        ? "valid and invalid seed probes were inconclusive; support remains disabled; no task was created"
        : `validator conclusively classified seed as ${kling.seedVerdict}; no task was created`),
  ];
}

async function cleanupCount(db, generationIds, userIds) {
  await db.delete(generations).where(inArray(generations.id, generationIds));
  await db.delete(userLimits).where(inArray(userLimits.userId, userIds));
  await db.delete(users).where(inArray(users.id, userIds));
  const [[g], [u], [l]] = await Promise.all([
    db.select({ n: count() }).from(generations).where(inArray(generations.id, generationIds)),
    db.select({ n: count() }).from(users).where(inArray(users.id, userIds)),
    db.select({ n: count() }).from(userLimits).where(inArray(userLimits.userId, userIds)),
  ]);
  return Number(g.n) + Number(u.n) + Number(l.n);
}

async function queueCheck({ db, origin, fetchImpl }) {
  const auditId = randomUUID();
  const userIds = [randomUUID(), randomUUID()];
  const generationIds = [randomUUID(), randomUUID(), randomUUID()];
  let passed = false;
  let cleanup = -1;
  try {
    const now = Date.now();
    await db.insert(users).values(userIds.map((id, index) => ({
      id, email: `audit-${auditId}-${index}@invalid.local`, passwordHash: "audit", passwordSalt: "audit",
      name: "Audit fixture", role: "user", isActive: true, authVersion: 0, createdAt: now,
    })));
    // A diagnostic-only kind keeps the smoke test isolated from real image/video
    // traffic while exercising the exact same generic per-kind SQL and route.
    const base = { kind: "audit", prompt: "audit", model: "audit", aspectRatio: "1:1", costCents: 0, createdAt: now, updatedAt: now };
    await db.insert(generations).values([
      { ...base, id: generationIds[0], userId: userIds[0], status: "running", createdAt: now },
      { ...base, id: generationIds[1], userId: userIds[0], status: "queued", createdAt: now + 1 },
      { ...base, id: generationIds[2], userId: userIds[1], status: "queued", createdAt: now + 2 },
    ]);
    await db.insert(userLimits).values({
      userId: userIds[0], key: "maxConcurrentJobs", value: "1", updatedAt: now,
    });
    const status = async (id, userId) => {
      const response = await fetchImpl(`${origin}/api/queue/status?id=${id}`, {
        headers: { cookie: `${SESSION_COOKIE}=${signSession(userId, 0)}` }, cache: "no-store",
      });
      if (!response.ok) throw new Error(`queue route returned HTTP ${response.status}`);
      return response.json();
    };
    const [sameUser, otherUser] = await Promise.all([
      status(generationIds[1], userIds[0]), status(generationIds[2], userIds[1]),
    ]);
    await db.insert(userLimits).values({
      userId: userIds[0], key: "maxConcurrentJobs", value: "2", updatedAt: now,
    }).onConflictDoUpdate({
      target: [userLimits.userId, userLimits.key],
      set: { value: "2", updatedAt: now },
    });
    const overridden = await status(generationIds[1], userIds[0]);
    passed = sameUser.position === 1 && sameUser.heldForConcurrency === true &&
      otherUser.position === 0 && overridden.position === 0;
  } finally {
    cleanup = await cleanupCount(db, generationIds, userIds);
  }
  if (cleanup !== 0) throw new Error("queue fixture cleanup count was nonzero");
  if (!passed) throw new Error("two-user fairness or override precedence failed");
  return "real queue route passed fairness, isolation, override, and zero-fixture cleanup";
}

async function flaggedCheck({ db, origin, adminCookie, adminId, fetchImpl }) {
  const id = randomUUID();
  const marker = `audit ${randomUUID()}, \"quoted\"\nsecond line`;
  let cleanup = -1;
  let passed = false;
  try {
    const now = Date.now();
    await db.insert(generations).values({
      id, kind: "image", status: "succeeded", prompt: marker, model: "Nano Banana Pro",
      aspectRatio: "1:1", userId: adminId, costCents: 0, flagged: true, flaggedAt: now,
      flagReason: "audit reason, \"quoted\"\nline", judgeScore: { identity: 42 }, createdAt: now, updatedAt: now,
    });
    const query = `flagged=1&q=${encodeURIComponent(marker)}`;
    const headers = { cookie: adminCookie };
    const [jsonResponse, csvResponse] = await Promise.all([
      fetchImpl(`${origin}/api/admin/logs?${query}`, { headers, cache: "no-store" }),
      fetchImpl(`${origin}/api/admin/logs?${query}&format=csv`, { headers, cache: "no-store" }),
    ]);
    if (!jsonResponse.ok || !csvResponse.ok) throw new Error("flagged routes did not return success");
    const page = await jsonResponse.json();
    const csv = parseCsv(await csvResponse.text());
    const header = csv[0] ?? [];
    const promptIndex = header.indexOf("prompt");
    const reasonIndex = header.indexOf("flag_reason");
    const scoreIndex = header.indexOf("judge_score");
    const csvRow = csv.find((row) => row[promptIndex] === marker);
    passed = page.total === 1 && page.rows[0]?.flagReason?.includes("audit reason") &&
      page.rows[0]?.judgeScore?.identity === 42 && csvRow?.[reasonIndex]?.includes("audit reason") &&
      JSON.parse(csvRow?.[scoreIndex] || "null")?.identity === 42;
  } finally {
    await db.delete(generations).where(eq(generations.id, id));
    const [left] = await db.select({ n: count() }).from(generations).where(eq(generations.id, id));
    cleanup = Number(left.n);
  }
  if (cleanup !== 0) throw new Error("flagged fixture cleanup count was nonzero");
  if (!passed) throw new Error("flagged JSON/CSV evidence or RFC 4180 parsing failed");
  return "real flagged JSON and CSV routes passed evidence, RFC 4180, and zero-fixture cleanup";
}

async function spoolCase({ forceFailure = false } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "veevee-runtime-spool-"));
  let forced = false;
  try {
    const payloads = ["synthetic-a", "synthetic-b", "synthetic-c"];
    const { candidates, errors } = await generateAndSpoolCandidates({
      count: payloads.length,
      directory,
      generate: async (index) => ({
        base64: Buffer.from(payloads[index]).toString("base64"),
        mimeType: "image/png",
      }),
    });
    if (errors.length || candidates.length !== payloads.length) {
      throw new Error("synthetic spool did not preserve every candidate");
    }
    if (candidates.some((candidate) =>
      Object.keys(candidate).sort().join(",") !== "file,mimeType" || "base64" in candidate
    )) {
      throw new Error("candidate memory retained payload data");
    }
    const files = await readdir(directory);
    if (files.length !== payloads.length) throw new Error("spool file count differed");
    const decoded = Buffer.from(await readSpooledBase64(candidates[1]), "base64").toString();
    if (decoded !== payloads[1]) throw new Error("spooled bytes differed");
    if (forceFailure) {
      forced = true;
      throw new Error("forced spool diagnostic failure");
    }
  } catch (error) {
    if (!forced) throw error;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  try {
    await access(directory);
    throw new Error("spool temporary directory remained after cleanup");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export async function spoolCheck() {
  await spoolCase();
  await spoolCase({ forceFailure: true });
  return "real spool library retained metadata only and removed both success and forced-failure directories";
}

export async function deadlineCheck({ db, forceAfterInsert = false, fixtureId = randomUUID() } = {}) {
  const id = fixtureId;
  let persistedBeforeReturn = false;
  try {
    const now = Date.now();
    await db.insert(generations).values({
      id, kind: "audit", status: "running", prompt: "audit", model: "audit",
      aspectRatio: "1:1", costCents: 0, createdAt: now, updatedAt: now,
    });
    if (forceAfterInsert) throw new Error("forced deadline fixture failure");
    const settled = await settleQueueExecution({
      timeoutMs: 15,
      work: (signal) => abortableDelay(1_000, signal),
      onSuccess: async () => { throw new Error("deadline diagnostic unexpectedly succeeded"); },
      onFailure: async (error) => {
        await db.update(generations).set({
          status: "failed", error: error.message, updatedAt: Date.now(),
        }).where(eq(generations.id, id));
        return "failed";
      },
    });
    const [row] = await db.select({ status: generations.status }).from(generations)
      .where(eq(generations.id, id));
    persistedBeforeReturn = settled === "failed" && row?.status === "failed";
  } finally {
    await db.delete(generations).where(eq(generations.id, id));
  }
  const [left] = await db.select({ n: count() }).from(generations).where(eq(generations.id, id));
  if (Number(left.n) !== 0) throw new Error("deadline fixture cleanup count was nonzero");
  if (!persistedBeforeReturn) throw new Error("terminal deadline state was not persisted before return");
  return "short internal deadline persisted terminal state before return and left zero fixtures";
}

async function safeCheck(id, fn) {
  try { return result(id, "ok", await fn()); }
  catch (error) { return result(id, "error", error instanceof Error ? error.message : error); }
}

export async function runRuntimeAudit({ origin, adminCookie, adminId, fetchImpl = fetch } = {}) {
  const checkedAt = Date.now();
  const auditId = randomUUID();
  const db = await getDb();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);
  const klingPromise = runKlingValidation({ fetchImpl, signal: controller.signal }).catch((error) => ({ error }));
  const [migration, queue, flagged, rel02, rel03, kling] = await Promise.all([
    safeCheck("MIG-04", async () => {
      await db.execute(sql`select 1`);
      if (activeDatabaseBackend() !== "cloud-sql") {
        throw new Error("active backend is direct PostgreSQL, not Cloud SQL");
      }
      return "active Cloud SQL backend answered a production query";
    }),
    safeCheck("ARCH-03", () => queueCheck({ db, origin, fetchImpl })),
    safeCheck("QUAL-03", () => flaggedCheck({ db, origin, adminCookie, adminId, fetchImpl })),
    safeCheck("REL-02", () => spoolCheck()),
    safeCheck("REL-03", () => deadlineCheck({ db })),
    klingPromise,
  ]);
  clearTimeout(timer);

  let arch04, ver08, ver10;
  if (kling?.error) {
    arch04 = result("ARCH-04", "error", kling.error.message);
    ver08 = result("VER-08", "error", kling.error.message);
    ver10 = result("VER-10", "unknown", "seed validation timed out or failed without a conclusive signal");
  } else if (!kling?.configured || !kling?.authenticated) {
    const detail = kling?.configured ? "Kling authentication failed" : "Kling validation credential is not configured";
    arch04 = result("ARCH-04", "unknown", detail);
    ver08 = result("VER-08", "unknown", detail);
    ver10 = result("VER-10", "unknown", detail);
  } else {
    [arch04, ver08, ver10] = klingAuditResults(kling);
  }
  const checks = [migration, queue, flagged, arch04, ver08, ver10, rel02, rel03];
  if (checks.map((check) => check.id).join() !== CHECK_IDS.join()) throw new Error("audit response shape drifted");
  return { checkedAt, auditId, checks };
}
