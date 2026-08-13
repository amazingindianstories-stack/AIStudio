import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { users, generations } from "@/lib/schema";
import { adminOrNull } from "@/lib/admin";
import { readAdminStats } from "@/lib/admin-stats";
import { readPricing } from "@/lib/pricing-db";
import { readAllGlobalLimits, readAllUserLimits } from "@/lib/limits-db";

export const runtime = "nodejs";

/**
 * The dashboard's fixed context, and only that: users (per-user gen count + cost
 * aggregated in SQL), headline stats + charts (also SQL), and pricing.
 *
 * It ships **no list rows at all** — neither generations nor activity. It used to
 * carry the newest 500 generations with full prompt text, which made this
 * response 2.2 MB (95% of it prompts) and, worse, made every Overview figure
 * secretly mean "over the newest 500" rather than over the table: the
 * Generations tile sat frozen at 500 and Total spend under-reported by 41%.
 * Totals now come from readAdminStats(), the browsable log from
 * /api/admin/logs, and the audit trail from /api/admin/activity — all three
 * paging and filtering server-side.
 *
 * What is left is bounded by the number of users and pricing rows, so this route
 * no longer grows with usage. Keep it that way: a list belongs in its own paged
 * endpoint, not here.
 */
export async function GET() {
  const me = await adminOrNull();
  if (!me) return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
  const db = await getDb();

  const [allUsers, stats, pricing, globalLimits, allUserLimits, statRows] = await Promise.all([
    db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        role: users.role,
        color: users.color,
        avatarUrl: users.avatarUrl,
        isActive: users.isActive,
        createdAt: users.createdAt,
      })
      .from(users),
    readAdminStats(),
    readPricing(),
    readAllGlobalLimits(),
    readAllUserLimits(),
    db
      .select({
        userId: generations.userId,
        genCount: sql`count(*)::int`,
        // Only counts rows that actually reached the provider and finished —
        // see the comment in admin-stats.ts's identical fix for why.
        costCents: sql`coalesce(sum(case when ${generations.status} = 'succeeded' then ${generations.costCents} else 0 end), 0)::int`,
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
        avatarUrl: u.avatarUrl,
        isActive: u.isActive,
        createdAt: u.createdAt,
        // Only the keys this user has a personal override for — see
        // readAllUserLimits's doc comment. The client falls back to
        // globalLimits for anything not present here.
        limits: allUserLimits[u.id] ?? {},
        genCount: stat?.genCount ?? 0,
        costCents: stat?.costCents ?? 0,
      };
    })
    .sort((a, b) => b.costCents - a.costCents);

  return NextResponse.json({
    users: usersOut,
    stats,
    pricing,
    limits: globalLimits,
  });
}
