import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { users } from "@/lib/schema";
import { adminOrNull } from "@/lib/admin";
import { limitDefinition } from "@/lib/limits";
import { updateUserLimit } from "@/lib/limits-db";
import { logActivity } from "@/lib/activity";

export const runtime = "nodejs";

/** Set or clear one user's personal override for one registered limit
 *  (src/lib/limits.ts). Body: { userId, key, value }, where value is a
 *  number to set/replace the override or null to clear it (reverting the
 *  user to the global default from /api/admin/limits). Generic across every
 *  limit type, same reasoning as that route. */
export async function POST(req) {
  const me = await adminOrNull();
  if (!me) return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
  const b = await req.json().catch(() => ({}));
  const userId = typeof b.userId === "string" ? b.userId : "";
  const key = typeof b.key === "string" ? b.key : "";
  const def = limitDefinition(key);
  if (!userId || !def) {
    return NextResponse.json({ error: "userId and a valid key are required." }, { status: 400 });
  }
  if (b.value !== null && (!Number.isFinite(b.value) || b.value < def.min)) {
    return NextResponse.json({ error: `Invalid ${def.label.toLowerCase()}.` }, { status: 400 });
  }

  const db = await getDb();
  const [target] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1);
  if (!target) return NextResponse.json({ error: "User not found." }, { status: 404 });

  const value = b.value === null ? null : Math.round(Number(b.value));
  await updateUserLimit(userId, key, value);
  await logActivity(me.id, "admin_user_limit_updated", { targetUserId: userId, key, value });
  return NextResponse.json({ ok: true });
}
