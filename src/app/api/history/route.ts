import { NextRequest, NextResponse } from "next/server";
import {
  readHistory,
  deleteItem,
  getItem,
  setItemFavorite,
  setItemFolder,
} from "@/lib/store-db";
import { getSession } from "@/lib/auth";
import { logActivity } from "@/lib/activity";
import { HISTORY_PAGE_SIZE } from "@/lib/config";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const cursor = req.nextUrl.searchParams.get("cursor");
  const limit = req.nextUrl.searchParams.get("limit");
  const cursorNum = cursor ? parseInt(cursor, 10) : undefined;
  const limitNum = limit ? parseInt(limit, 10) : HISTORY_PAGE_SIZE;

  const items = await readHistory(cursorNum, limitNum);
  return NextResponse.json({ items });
}

/** Update generation metadata: move into folders or toggle favourites. */
export async function PATCH(req: NextRequest) {
  const b = await req.json().catch(() => ({}));
  if (!b.id) {
    return NextResponse.json({ error: "Missing id." }, { status: 400 });
  }
  const updated =
    typeof b.isFavorite === "boolean"
      ? await setItemFavorite(b.id, b.isFavorite)
      : await setItemFolder(
          b.id,
          b.projectId ?? undefined,
          b.folderId ?? undefined
        );
  if (!updated) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  return NextResponse.json(updated);
}

export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "Missing id." }, { status: 400 });
  }
  const user = await getSession();
  // Capture what is being deleted before it's gone, for the audit trail.
  const item = await getItem(id);
  await deleteItem(id);
  await logActivity(user?.id ?? null, "delete", {
    id,
    kind: item?.kind,
    model: item?.model,
    prompt: item?.prompt?.slice(0, 120),
    ownerId: item?.userId ?? null,
  });
  return NextResponse.json({ ok: true });
}
