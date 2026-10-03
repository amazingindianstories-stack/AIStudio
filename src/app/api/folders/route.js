import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import {
  createFolder,
  renameFolder,
  moveFolder,
  deleteFolder,
  getFolderAncestry,
  getFolderChildren,
  getLibraryTree,
  OrganizationError,
} from "@/lib/folder-engine";

export const runtime = "nodejs";

/**
 * GET /api/folders
 * Query parameters:
 * - tree=1: Returns full library folder hierarchy
 * - ancestry=<folderId>: Returns breadcrumb trail for folder
 * - parentId=<folderId>: Returns immediate children of a folder
 * - projectId=<projectId>: Returns root folders of a project
 */
export async function GET(req) {
  if (!(await getSession())) {
    return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  }

  const { searchParams } = req.nextUrl;
  const tree = searchParams.get("tree");
  const ancestry = searchParams.get("ancestry");
  const parentId = searchParams.get("parentId");
  const projectId = searchParams.get("projectId");

  try {
    if (tree === "1" || tree === "true") {
      const libraryTree = await getLibraryTree();
      return NextResponse.json(libraryTree);
    }

    if (ancestry) {
      const breadcrumbs = await getFolderAncestry(ancestry);
      return NextResponse.json({ breadcrumbs });
    }

    const children = await getFolderChildren({
      parentId: parentId || null,
      projectId: projectId || null,
    });
    return NextResponse.json({ folders: children });
  } catch (error) {
    if (error instanceof OrganizationError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status }
      );
    }
    console.error("[api/folders GET] Error:", error);
    return NextResponse.json(
      { error: error?.message || "Failed to fetch folders." },
      { status: 500 }
    );
  }
}

/**
 * POST /api/folders
 * Create a new folder (global root, project root, or subfolder).
 * Body: { name: string, projectId?: string | null, parentId?: string | null }
 */
export async function POST(req) {
  const user = await getSession();
  if (!user) {
    return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const { name, projectId, parentId } = body;
  const idempotencyKey =
    body.idempotencyKey ||
    req.headers.get("x-idempotency-key") ||
    req.headers.get("idempotency-key") ||
    null;

  try {
    const folder = await createFolder({
      name,
      projectId: projectId || null,
      parentId: parentId || null,
      idempotencyKey,
      actorId: user.id,
    });
    return NextResponse.json({ folder }, { status: 201 });
  } catch (error) {
    if (error instanceof OrganizationError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status }
      );
    }
    console.error("[api/folders POST] Error creating folder:", error);
    return NextResponse.json(
      { error: error?.message || "Failed to create folder." },
      { status: 500 }
    );
  }
}

/**
 * PATCH /api/folders
 * Rename or move a folder.
 * Body options:
 * 1. Rename: { id: string, name: string, projectId?: string, expectedVersion?: number }
 * 2. Move: { id: string, destination: { type: 'global_root' | 'project_root' | 'folder', projectId?: string, folderId?: string }, expectedVersion?: number }
 */
export async function PATCH(req) {
  const user = await getSession();
  if (!user) {
    return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const folderId = body.id || body.folderId;
  const idempotencyKey =
    body.idempotencyKey ||
    req.headers.get("x-idempotency-key") ||
    req.headers.get("idempotency-key") ||
    null;

  if (!folderId) {
    return NextResponse.json({ error: "Folder ID is required." }, { status: 400 });
  }

  try {
    if (typeof body.name === "string") {
      const folder = await renameFolder({
        folderId,
        projectId: body.projectId,
        name: body.name,
        expectedVersion: body.expectedVersion,
        idempotencyKey,
        actorId: user.id,
      });
      return NextResponse.json({ folder });
    }

    if (body.destination && typeof body.destination === "object") {
      const result = await moveFolder({
        folderId,
        destination: body.destination,
        expectedVersion: body.expectedVersion,
        idempotencyKey,
        actorId: user.id,
      });
      return NextResponse.json(result);
    }

    return NextResponse.json(
      { error: "Must specify 'name' to rename or 'destination' to move." },
      { status: 400 }
    );
  } catch (error) {
    if (error instanceof OrganizationError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status }
      );
    }
    console.error("[api/folders PATCH] Error mutating folder:", error);
    return NextResponse.json(
      { error: error?.message || "Failed to update folder." },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/folders
 * Non-recursively delete an empty folder.
 * Query param: ?id=<folderId>&projectId=<optional>
 */
export async function DELETE(req) {
  const user = await getSession();
  if (!user) {
    return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  }

  const { searchParams } = req.nextUrl;
  const folderId = searchParams.get("id") || searchParams.get("folderId");
  const projectId = searchParams.get("projectId") || undefined;
  const idempotencyKey =
    searchParams.get("idempotencyKey") ||
    req.headers.get("x-idempotency-key") ||
    req.headers.get("idempotency-key") ||
    null;

  if (!folderId) {
    return NextResponse.json({ error: "Folder ID is required." }, { status: 400 });
  }

  try {
    const result = await deleteFolder({
      folderId,
      projectId,
      idempotencyKey,
      actorId: user.id,
    });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof OrganizationError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status }
      );
    }
    console.error("[api/folders DELETE] Error deleting folder:", error);
    return NextResponse.json(
      { error: error?.message || "Failed to delete folder." },
      { status: 500 }
    );
  }
}
