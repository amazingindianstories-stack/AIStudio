import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { getQueuePosition } from "@/lib/store-db";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    await requireUser();
    const id = req.nextUrl.searchParams.get("id");
    if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

    const statusObj = await getQueuePosition(id);
    if (!statusObj) return NextResponse.json({ error: "Not found" }, { status: 404 });

    return NextResponse.json(statusObj);
  } catch (e: any) {
    if (e.message === "UNAUTHENTICATED") {
      return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
