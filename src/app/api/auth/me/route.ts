import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import {
  getSession,
  SESSION_COOKIE,
  type SessionUser,
} from "@/lib/auth";
import { getDb } from "@/lib/db";
import { users } from "@/lib/schema";
import { logActivity } from "@/lib/activity";
import {
  deleteAvatarImage,
  InvalidAvatarError,
  MAX_AVATAR_UPLOAD_BYTES,
  saveAvatarImage,
} from "@/lib/save-media";

export const runtime = "nodejs";

const ALLOWED_AVATAR_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
  "image/tiff",
  "image/heif",
  "image/heic",
]);

type AvatarChange =
  | { kind: "remove" }
  | { kind: "upload"; buffer: Buffer };

interface ProfileUpdate {
  name?: string;
  avatar?: AvatarChange;
}

function publicUser(user: SessionUser) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    color: user.color,
    avatarUrl: user.avatarUrl,
  };
}

function clearSession(response: NextResponse): NextResponse {
  response.cookies.set(SESSION_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });
  return response;
}

function validateName(value: unknown): string {
  if (typeof value !== "string") throw new InvalidAvatarError("Name is required.");
  const name = value.trim();
  if (!name) throw new InvalidAvatarError("Name cannot be empty.");
  if (name.length > 80) {
    throw new InvalidAvatarError("Name must be 80 characters or fewer.");
  }
  if (/[\u0000-\u001f\u007f]/.test(name)) {
    throw new InvalidAvatarError("Name cannot contain control characters.");
  }
  return name;
}

function decodeDataUrl(input: string): Buffer {
  if (input.length > Math.ceil((MAX_AVATAR_UPLOAD_BYTES * 4) / 3) + 1024) {
    throw new InvalidAvatarError("Profile images must be 3 MB or smaller.");
  }
  const match = input.match(/^data:([^;,]+);base64,([a-zA-Z0-9+/]+={0,2})$/s);
  if (!match || !ALLOWED_AVATAR_TYPES.has(match[1].toLowerCase())) {
    throw new InvalidAvatarError("Choose a JPEG, PNG, WebP, GIF, AVIF, or TIFF image.");
  }
  const buffer = Buffer.from(match[2], "base64");
  if (!buffer.length || buffer.length > MAX_AVATAR_UPLOAD_BYTES) {
    throw new InvalidAvatarError(
      buffer.length ? "Profile images must be 3 MB or smaller." : "The selected image is empty."
    );
  }
  return buffer;
}

function validateFile(file: File): void {
  if (!ALLOWED_AVATAR_TYPES.has(file.type.toLowerCase())) {
    throw new InvalidAvatarError("Choose a JPEG, PNG, WebP, GIF, AVIF, or TIFF image.");
  }
  if (!file.size) throw new InvalidAvatarError("The selected image is empty.");
  if (file.size > MAX_AVATAR_UPLOAD_BYTES) {
    throw new InvalidAvatarError("Profile images must be 3 MB or smaller.");
  }
}

async function readProfileRequest(req: NextRequest): Promise<ProfileUpdate> {
  const contentType = req.headers.get("content-type")?.toLowerCase() ?? "";
  const update: ProfileUpdate = {};

  if (contentType.startsWith("multipart/form-data")) {
    const form = await req.formData();
    if (form.has("name")) update.name = validateName(form.get("name"));

    if (form.get("removeAvatar") === "true") {
      update.avatar = { kind: "remove" };
    } else if (form.has("avatar")) {
      const avatar = form.get("avatar");
      if (!avatar || typeof avatar === "string") {
        throw new InvalidAvatarError("Choose an image to upload.");
      }
      validateFile(avatar);
      update.avatar = {
        kind: "upload",
        buffer: Buffer.from(await avatar.arrayBuffer()),
      };
    }
  } else if (contentType.startsWith("application/json")) {
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") {
      throw new InvalidAvatarError("Invalid profile update.");
    }
    if (Object.prototype.hasOwnProperty.call(body, "name")) {
      update.name = validateName(body.name);
    }
    if (body.avatar === null || body.removeAvatar === true) {
      update.avatar = { kind: "remove" };
    } else if (Object.prototype.hasOwnProperty.call(body, "avatar")) {
      if (typeof body.avatar !== "string") {
        throw new InvalidAvatarError("An image data URL is required.");
      }
      update.avatar = { kind: "upload", buffer: decodeDataUrl(body.avatar) };
    }
  } else {
    throw new InvalidAvatarError("Send profile data as JSON or multipart form data.");
  }

  if (update.name === undefined && update.avatar === undefined) {
    throw new InvalidAvatarError("Nothing to update.");
  }
  return update;
}

export async function GET() {
  const user = await getSession();
  if (!user) return clearSession(NextResponse.json({ user: null }));
  return NextResponse.json({ user: publicUser(user) });
}

export async function PATCH(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return clearSession(
      NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 })
    );
  }
  const db = await getDb();

  let request: ProfileUpdate;
  try {
    request = await readProfileRequest(req);
  } catch (error) {
    const message =
      error instanceof InvalidAvatarError ? error.message : "Invalid profile update.";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const changedFields: string[] = [];
  const set: { name?: string; avatarUrl?: string | null } = {};
  if (request.name !== undefined && request.name !== session.name) {
    set.name = request.name;
    changedFields.push("name");
  }

  let uploadedAvatarUrl: string | null = null;
  try {
    if (request.avatar?.kind === "upload") {
      uploadedAvatarUrl = await saveAvatarImage(request.avatar.buffer);
      set.avatarUrl = uploadedAvatarUrl;
      changedFields.push("avatar");
    } else if (request.avatar?.kind === "remove") {
      set.avatarUrl = null;
      if (session.avatarUrl !== null) changedFields.push("avatar");
    }

    if (!changedFields.length) {
      return NextResponse.json({ error: "Nothing to update." }, { status: 400 });
    }

    const [updated] = await db
      .update(users)
      .set(set)
      .where(
        and(
          eq(users.id, session.id),
          eq(users.isActive, true),
          eq(users.authVersion, session.authVersion)
        )
      )
      .returning({
        id: users.id,
        email: users.email,
        name: users.name,
        role: users.role,
        color: users.color,
        avatarUrl: users.avatarUrl,
      });

    if (!updated) {
      await deleteAvatarImage(uploadedAvatarUrl);
      return clearSession(
        NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 })
      );
    }

    if (request.avatar && session.avatarUrl !== updated.avatarUrl) {
      await deleteAvatarImage(session.avatarUrl);
    }
    await logActivity(session.id, "profile_updated", { changedFields });
    return NextResponse.json({ user: updated });
  } catch (error) {
    await deleteAvatarImage(uploadedAvatarUrl);
    if (error instanceof InvalidAvatarError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error("Failed to update profile", error);
    return NextResponse.json(
      { error: "Could not update the profile." },
      { status: 500 }
    );
  }
}
