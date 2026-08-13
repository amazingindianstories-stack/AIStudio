import { NextResponse } from "next/server";
import {
  queryHistory,
  decodeCursor,
  deleteItem,
  getItem,
  setItemFavorite,
  setItemFolder,
} from "@/lib/store-db";
import { getSession, canManage } from "@/lib/auth";
import { logActivity } from "@/lib/activity";
import { HISTORY_PAGE_SIZE } from "@/lib/config";
import { parseHistoryFilter, MAX_PAGE_SIZE } from "@/lib/history-query";

export const runtime = "nodejs";

export async function GET(req) {
  if (!(await getSession())) {
    return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  }
  const params = req.nextUrl.searchParams;
  const filter = parseHistoryFilter(params);
  const cursor = decodeCursor(params.get("cursor"));

  const rawLimit = parseInt(params.get("limit") ?? "", 10);
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(rawLimit, 1), MAX_PAGE_SIZE)
    : HISTORY_PAGE_SIZE;

  const page = await queryHistory(filter, cursor, limit);
  // nextCursor is explicit rather than inferred by the client from
  // `items.length === limit`, which guesses wrong whenever the total is an
  // exact multiple of the page size and leaves a sentinel that never resolves.
  return NextResponse.json(page);
}

/** Update generation metadata: move into folders or toggle favourites. */
export async function PATCH(req) {
  if (!(await getSession())) {
    return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  }
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

export async function DELETE(req) {
  const user = await getSession();
  if (!user) {
    return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  }
  const id = req.nextUrl.searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "Missing id." }, { status: 400 });
  }
  // Capture what is being deleted before it's gone, for the audit trail.
  const item = await getItem(id);
  if (!item) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  // Anyone on the shared project can view/favorite/refile this item — deletion
  // is the one irreversible action, so it's the one gated to the owner or an
  // admin. See canManage()'s docstring in auth.js for the reasoning.
  if (!canManage(user, item.userId)) {
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
  }
  await deleteItem(id);
  await logActivity(user.id, "delete", {
    id,
    kind: item?.kind,
    model: item?.model,
    prompt: item?.prompt?.slice(0, 120),
    ownerId: item?.userId ?? null,
  });
  return NextResponse.json({ ok: true });
}
