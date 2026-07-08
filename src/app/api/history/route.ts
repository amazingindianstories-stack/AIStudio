import { NextRequest, NextResponse } from "next/server";
import {
  readHistory,
  deleteItem,
  setItemFavorite,
  setItemFolder,
} from "@/lib/store-db";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const cursor = req.nextUrl.searchParams.get("cursor");
  const limit = req.nextUrl.searchParams.get("limit");
  const cursorNum = cursor ? parseInt(cursor, 10) : undefined;
  const limitNum = limit ? parseInt(limit, 10) : 20;
  
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
  await deleteItem(id);
  return NextResponse.json({ ok: true });
}
