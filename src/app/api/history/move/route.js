import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { moveGenerations, OrganizationError } from "@/lib/folder-engine";

export const runtime = "nodejs";

/**
 * POST /api/history/move
 * Authoritative atomic single/bulk move endpoint for generations.
 * Body: {
 *   ids: string[],
 *   destination: {
 *     type: 'folder' | 'global_unsorted' | 'project_unsorted' | 'project_root' | 'global_root',
 *     folderId?: string,
 *     projectId?: string
 *   }
 * }
 */
export async function POST(req) {
  const user = await getSession();
  if (!user) {
    return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const { ids, destination, expectedVersions } = body;
  const idempotencyKey =
    body.idempotencyKey ||
    req.headers.get("x-idempotency-key") ||
    req.headers.get("idempotency-key") ||
    null;

  if (!Array.isArray(ids) || ids.length === 0) {
    return NextResponse.json(
      { error: "At least one generation ID is required." },
      { status: 400 }
    );
  }

  if (!destination || typeof destination !== "object") {
    return NextResponse.json(
      { error: "Destination descriptor is required." },
      { status: 400 }
    );
  }

  try {
    const result = await moveGenerations({
      ids,
      destination,
      expectedVersions,
      idempotencyKey,
      actorId: user.id,
    });
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    if (error instanceof OrganizationError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status }
      );
    }
    console.error("[api/history/move] Error moving generations:", error);
    return NextResponse.json(
      { error: error?.message || "Failed to move generations." },
      { status: 500 }
    );
  }
}
