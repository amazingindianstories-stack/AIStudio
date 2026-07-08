import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/lib/schema";
import { adminOrNull } from "@/lib/admin";
import { hashPassword } from "@/lib/password";

export const runtime = "nodejs";

const COLORS = [
  "#34d399",
  "#60a5fa",
  "#f472b6",
  "#fbbf24",
  "#a78bfa",
  "#f87171",
  "#22d3ee",
  "#fb923c",
];

/** Create a user. Body: { email, password, name, role } */
export async function POST(req: NextRequest) {
  if (!(await adminOrNull()))
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
  const b = await req.json().catch(() => ({}));
  const email = String(b.email || "").toLowerCase().trim();
  const password = String(b.password || "");
  const name = String(b.name || "").trim() || email.split("@")[0];
  const role = b.role === "admin" ? "admin" : "user";
  if (!email || !password)
    return NextResponse.json(
      { error: "Email and password are required." },
      { status: 400 }
    );

  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (existing.length)
    return NextResponse.json(
      { error: "A user with that email already exists." },
      { status: 409 }
    );

  const { hash, salt } = hashPassword(password);
  const [row] = await db
    .insert(users)
    .values({
      email,
      passwordHash: hash,
      passwordSalt: salt,
      name,
      role,
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
      isActive: true,
      createdAt: Date.now(),
    })
    .returning();
  return NextResponse.json({
    user: { id: row.id, email: row.email, name: row.name, role: row.role },
  });
}

/** Update a user. Body: { id, name?, role?, isActive?, password? } */
export async function PATCH(req: NextRequest) {
  if (!(await adminOrNull()))
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
  const b = await req.json().catch(() => ({}));
  if (!b.id)
    return NextResponse.json({ error: "Missing id." }, { status: 400 });

  const set: Record<string, unknown> = {};
  if (typeof b.name === "string") set.name = b.name.trim();
  if (b.role === "admin" || b.role === "user") set.role = b.role;
  if (typeof b.isActive === "boolean") set.isActive = b.isActive;
  if (b.password) {
    const { hash, salt } = hashPassword(String(b.password));
    set.passwordHash = hash;
    set.passwordSalt = salt;
  }
  if (Object.keys(set).length === 0)
    return NextResponse.json({ error: "Nothing to update." }, { status: 400 });

  await db.update(users).set(set).where(eq(users.id, b.id));
  return NextResponse.json({ ok: true });
}

/** Delete a user (can't delete yourself). */
export async function DELETE(req: NextRequest) {
  const me = await adminOrNull();
  if (!me) return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Missing id." }, { status: 400 });
  if (id === me.id)
    return NextResponse.json(
      { error: "You can't delete your own account." },
      { status: 400 }
    );
  await db.delete(users).where(eq(users.id, id));
  return NextResponse.json({ ok: true });
}
