import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { mediaExportItems, mediaExports } from "@/lib/schema";
import { createResumableUploadSession, getSignedReadUrl } from "@/lib/storage";

export const runtime = "nodejs";
function verifyWorkerToken(req) {
  const configured = process.env.GENERATION_WORKER_SECRET;
  const supplied = req.headers.get("x-generation-worker-secret");
  if (!configured || !supplied) return false;
  const expected = Buffer.from(configured); const actual = Buffer.from(supplied);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
export async function POST(req) {
  if (!verifyWorkerToken(req)) return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
  const body = await req.json().catch(() => ({})); const db = await getDb();
  const [job] = await db.select().from(mediaExports).where(and(eq(mediaExports.id, body.exportId), eq(mediaExports.status, "running"), eq(mediaExports.leaseOwner, body.owner))).limit(1);
  if (!job || !job.leaseUntil || job.leaseUntil < Date.now()) return NextResponse.json({ error: "LEASE_LOST" }, { status: 409 });
  if (body.action === "upload") {
    const key = `exports/${job.userId}/${job.id}.zip`;
    return NextResponse.json({ key, url: await createResumableUploadSession(key) });
  }
  if (body.action === "source") {
    const [item] = await db.select().from(mediaExportItems).where(and(eq(mediaExportItems.exportId, job.id), eq(mediaExportItems.generationId, body.generationId))).limit(1);
    if (!item) return NextResponse.json({ error: "ITEM_NOT_FOUND" }, { status: 404 });
    return NextResponse.json({ url: await getSignedReadUrl(item.sourceKey, 15 * 60) });
  }
  return NextResponse.json({ error: "INVALID_ACTION" }, { status: 400 });
}
