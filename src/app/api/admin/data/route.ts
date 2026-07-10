import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { users, generations } from "@/lib/schema";
import { adminOrNull } from "@/lib/admin";
import { readHistory } from "@/lib/store-db";
import { readPricing } from "@/lib/pricing-db";
import { readActivity } from "@/lib/activity";

export const runtime = "nodejs";

/** Log window returned to the dashboard (newest first). */
const LOG_LIMIT = 500;

/**
 * One read for the whole admin dashboard: users (per-user gen count + cost
 * aggregated in SQL over ALL generations, not just the log window), the
 * generation log, the audit-trail activity (logins, generates, deletes, …),
 * and pricing. The client does filtering + chart aggregation in memory (fine
 * at studio scale).
 */
export async function GET() {
  const me = await adminOrNull();
  if (!me) return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });

  const [allUsers, gens, pricing, activity, statRows] = await Promise.all([
    db.select().from(users),
    readHistory(undefined, LOG_LIMIT),
    readPricing(),
    readActivity(LOG_LIMIT),
    db
      .select({
        userId: generations.userId,
        genCount: sql<number>`count(*)::int`,
        costCents: sql<number>`coalesce(sum(${generations.costCents}), 0)::int`,
      })
      .from(generations)
      .groupBy(generations.userId),
  ]);

  const statsByUser = new Map(statRows.map((r) => [r.userId, r]));
  const usersOut = allUsers
    .map((u) => {
      const stat = statsByUser.get(u.id);
      return {
        id: u.id,
        email: u.email,
        name: u.name,
        role: u.role,
        color: u.color,
        isActive: u.isActive,
        createdAt: u.createdAt,
        genCount: stat?.genCount ?? 0,
        costCents: stat?.costCents ?? 0,
      };
    })
    .sort((a, b) => b.costCents - a.costCents);

  const generationsOut = gens.map((g) => ({
    id: g.id,
    kind: g.kind,
    model: g.model,
    status: g.status,
    costCents: g.costCents ?? 0,
    userId: g.userId ?? null,
    prompt: g.prompt,
    createdAt: g.createdAt,
  }));

  return NextResponse.json({
    users: usersOut,
    generations: generationsOut,
    activity,
    pricing,
  });
}
