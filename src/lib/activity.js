import { getDb } from "./db";
import { activityLogs } from "./schema";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Append an admin audit-trail event. Best-effort (never throws to caller). */
export async function logActivity(
  userId,
  action,
  detail,
  tx = null
) {
  try {
    const validUserId = typeof userId === "string" && UUID_REGEX.test(userId) ? userId : null;
    const finalDetail = !validUserId && userId ? { ...(detail || {}), nonUuidActor: String(userId) } : (detail ?? null);
    const runner = tx || (await getDb());
    await runner.insert(activityLogs).values({
      userId: validUserId,
      action,
      detail: finalDetail,
      createdAt: Date.now(),
    });
  } catch {
    /* logging must never break the request */
  }
}

/**
 * Reading the trail lives in `admin-activity.ts`, which pages and filters it in
 * SQL. The `readActivity(limit)` that used to be here returned a flat newest-N
 * window straight into /api/admin/data; it was deleted along with that field on
 * 2026-07-31 rather than left as an unused second way to read the same table.
 */
