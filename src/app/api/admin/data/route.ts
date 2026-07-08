import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { users } from "@/lib/schema";
import { adminOrNull } from "@/lib/admin";
import { readHistory } from "@/lib/store-db";
import { readPricing } from "@/lib/pricing-db";

export const runtime = "nodejs";

/**
 * One read for the whole admin dashboard: users (with per-user gen count + cost),
 * the generation log, and pricing. The client does filtering + chart aggregation
 * in memory (fine at studio scale).
 */
export async function GET() {
  const me = await adminOrNull();
  if (!me) return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });

  const [allUsers, gens, pricing] = await Promise.all([
    db.select().from(users),
    readHistory(),
    readPricing(),
  ]);

  const usersOut = allUsers
    .map((u) => {
      const mine = gens.filter((g) => g.userId === u.id);
      return {
        id: u.id,
        email: u.email,
        name: u.name,
        role: u.role,
        color: u.color,
        isActive: u.isActive,
        createdAt: u.createdAt,
        genCount: mine.length,
        costCents: mine.reduce((s, g) => s + (g.costCents ?? 0), 0),
      };
    })
    .sort((a, b) => b.costCents - a.costCents);

  const generations = gens.map((g) => ({
    id: g.id,
    kind: g.kind,
    model: g.model,
    status: g.status,
    costCents: g.costCents ?? 0,
    userId: g.userId ?? null,
    prompt: g.prompt,
    createdAt: g.createdAt,
  }));

  return NextResponse.json({ users: usersOut, generations, pricing });
}
