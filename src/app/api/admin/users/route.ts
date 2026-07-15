import { NextRequest, NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { users } from "@/lib/schema";
import { adminOrNull } from "@/lib/admin";
import { hashPassword, validatePassword } from "@/lib/password";
import { logActivity } from "@/lib/activity";
import { deleteAvatarImage } from "@/lib/save-media";

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

const SAFE_USER_FIELDS = {
  id: users.id,
  email: users.email,
  name: users.name,
  role: users.role,
  color: users.color,
  avatarUrl: users.avatarUrl,
  isActive: users.isActive,
  createdAt: users.createdAt,
};

/** Create a user. Body: { email, password, name, role } */
export async function POST(req: NextRequest) {
  const me = await adminOrNull();
  if (!me) return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
  const db = await getDb();

  const body = await req.json().catch(() => ({}));
  const email = String(body.email || "").toLowerCase().trim();
  const password = body.password;
  const name = String(body.name || "").trim() || email.split("@")[0];
  const role = body.role === "admin" ? "admin" : "user";
  if (!email) {
    return NextResponse.json({ error: "Email is required." }, { status: 400 });
  }
  const passwordError = validatePassword(password);
  if (passwordError) {
    return NextResponse.json({ error: passwordError }, { status: 400 });
  }

  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (existing.length) {
    return NextResponse.json(
      { error: "A user with that email already exists." },
      { status: 409 }
    );
  }

  const { hash, salt } = hashPassword(password);
  try {
    const [row] = await db
      .insert(users)
      .values({
        email,
        passwordHash: hash,
        passwordSalt: salt,
        name,
        role,
        color: COLORS[Math.floor(Math.random() * COLORS.length)],
        avatarUrl: null,
        isActive: true,
        authVersion: 0,
        createdAt: Date.now(),
      })
      .returning(SAFE_USER_FIELDS);

    await logActivity(me.id, "admin_user_created", {
      targetUserId: row.id,
      email: row.email,
      role: row.role,
    });
    return NextResponse.json({ user: row });
  } catch (error) {
    if ((error as { code?: string }).code === "23505") {
      return NextResponse.json(
        { error: "A user with that email already exists." },
        { status: 409 }
      );
    }
    throw error;
  }
}

/** Update a user. Body: { id, name?, role?, isActive?, password? } */
export async function PATCH(req: NextRequest) {
  const me = await adminOrNull();
  if (!me) return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
  const db = await getDb();

  const body = await req.json().catch(() => ({}));
  const id = typeof body.id === "string" ? body.id : "";
  if (!id) return NextResponse.json({ error: "Missing id." }, { status: 400 });

  const [target] = await db
    .select({
      ...SAFE_USER_FIELDS,
      authVersion: users.authVersion,
    })
    .from(users)
    .where(eq(users.id, id))
    .limit(1);
  if (!target) {
    return NextResponse.json({ error: "User not found." }, { status: 404 });
  }

  if (body.role !== undefined && body.role !== "admin" && body.role !== "user") {
    return NextResponse.json({ error: "Invalid role." }, { status: 400 });
  }
  if (body.isActive !== undefined && typeof body.isActive !== "boolean") {
    return NextResponse.json({ error: "Invalid account status." }, { status: 400 });
  }
  if (id === me.id && body.role === "user") {
    return NextResponse.json(
      { error: "You can't demote your own account." },
      { status: 400 }
    );
  }
  if (id === me.id && body.isActive === false) {
    return NextResponse.json(
      { error: "You can't disable your own account." },
      { status: 400 }
    );
  }
  if (id === me.id && body.password !== undefined) {
    return NextResponse.json(
      { error: "Change your own password from Account settings." },
      { status: 400 }
    );
  }
  if (body.password !== undefined) {
    const passwordError = validatePassword(body.password);
    if (passwordError) {
      return NextResponse.json({ error: passwordError }, { status: 400 });
    }
  }

  const set: {
    name?: string;
    role?: string;
    isActive?: boolean;
    passwordHash?: string;
    passwordSalt?: string;
    authVersion?: ReturnType<typeof sql>;
  } = {};
  const changedFields: string[] = [];
  let revokeSessions = false;

  if (typeof body.name === "string") {
    const name = body.name.trim();
    if (!name) {
      return NextResponse.json({ error: "Name cannot be empty." }, { status: 400 });
    }
    if (name !== target.name) {
      set.name = name;
      changedFields.push("name");
    }
  }
  if ((body.role === "admin" || body.role === "user") && body.role !== target.role) {
    set.role = body.role;
    changedFields.push("role");
    revokeSessions = true;
  }
  if (typeof body.isActive === "boolean" && body.isActive !== target.isActive) {
    set.isActive = body.isActive;
    changedFields.push("isActive");
    revokeSessions = true;
  }
  if (body.password !== undefined) {
    const { hash, salt } = hashPassword(body.password);
    set.passwordHash = hash;
    set.passwordSalt = salt;
    changedFields.push("password");
    revokeSessions = true;
  }
  if (!changedFields.length) {
    return NextResponse.json({ error: "Nothing to update." }, { status: 400 });
  }
  if (revokeSessions) set.authVersion = sql`${users.authVersion} + 1`;

  const [updated] = await db
    .update(users)
    .set(set)
    .where(eq(users.id, id))
    .returning(SAFE_USER_FIELDS);
  if (!updated) {
    return NextResponse.json({ error: "User not found." }, { status: 404 });
  }

  let action = "admin_user_updated";
  if (changedFields.length === 1 && changedFields[0] === "password") {
    action = "admin_password_reset";
  } else if (changedFields.length === 1 && changedFields[0] === "isActive") {
    action = updated.isActive ? "admin_user_enabled" : "admin_user_disabled";
  }
  await logActivity(me.id, action, {
    targetUserId: updated.id,
    changedFields,
  });
  return NextResponse.json({ user: updated });
}

/** Delete a user (can't delete yourself). */
export async function DELETE(req: NextRequest) {
  const me = await adminOrNull();
  if (!me) return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
  const db = await getDb();
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Missing id." }, { status: 400 });
  if (id === me.id) {
    return NextResponse.json(
      { error: "You can't delete your own account." },
      { status: 400 }
    );
  }

  const [target] = await db
    .select({ id: users.id, email: users.email, avatarUrl: users.avatarUrl })
    .from(users)
    .where(eq(users.id, id))
    .limit(1);
  if (!target) {
    return NextResponse.json({ error: "User not found." }, { status: 404 });
  }

  await db.delete(users).where(eq(users.id, id));
  await deleteAvatarImage(target.avatarUrl);
  await logActivity(me.id, "admin_user_deleted", {
    targetUserId: target.id,
    email: target.email,
  });
  return NextResponse.json({ ok: true });
}
