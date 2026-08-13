import { NextResponse } from "next/server";
import { adminOrNull } from "@/lib/admin";
import {
  ACTIVITY_PAGE_SIZE,
  decodeCursor,
  parseAdminActivityFilter,
  queryActivity,
} from "@/lib/admin-activity";

export const runtime = "nodejs";

/**
 * The admin audit trail, paged and filtered server-side.
 *
 * Split out of /api/admin/data for the same reason the generation log was: the
 * dashboard's fixed context (users, stats, pricing) is small and wanted on open,
 * while this list is unbounded and browsed. Once the log left, this one list was
 * ~94% of what /api/admin/data returned.
 */
export async function GET(req) {
  const me = await adminOrNull();
  if (!me) return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });

  const params = req.nextUrl.searchParams;
  const filter = parseAdminActivityFilter(params);
  const limit = Number(params.get("limit")) || ACTIVITY_PAGE_SIZE;

  const page = await queryActivity(filter, decodeCursor(params.get("cursor")), limit);
  return NextResponse.json(page);
}
