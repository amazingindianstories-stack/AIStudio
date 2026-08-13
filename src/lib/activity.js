import { getDb } from "./db";
import { activityLogs } from "./schema";

/** Append an admin audit-trail event. Best-effort (never throws to caller). */
export async function logActivity(
  userId,
  action,
  detail
) {
  try {
    const db = await getDb();
    await db.insert(activityLogs).values({
      userId: userId ?? null,
      action,
      detail: detail ?? null,
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
