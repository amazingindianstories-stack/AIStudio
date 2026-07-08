import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { users } from "@/lib/schema";
import { getSession } from "@/lib/auth";

export const runtime = "nodejs";

/** Public (logged-in) list of users for attribution display — no secrets. */
export async function GET() {
  const me = await getSession();
  if (!me) return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      color: users.color,
    })
    .from(users);
  return NextResponse.json({ users: rows });
}
