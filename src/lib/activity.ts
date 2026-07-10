import { desc } from "drizzle-orm";
import { db } from "./db";
import { activityLogs } from "./schema";

/** Append an admin audit-trail event. Best-effort (never throws to caller). */
export async function logActivity(
  userId: string | null,
  action: string,
  detail?: unknown
): Promise<void> {
  try {
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

export interface ActivityRow {
  id: string;
  userId: string | null;
  action: string;
  detail: unknown;
  createdAt: number;
}

/** Most recent audit-trail events, newest first. */
export async function readActivity(limitN = 500): Promise<ActivityRow[]> {
  const rows = await db
    .select()
    .from(activityLogs)
    .orderBy(desc(activityLogs.createdAt))
    .limit(limitN);
  return rows as ActivityRow[];
}
