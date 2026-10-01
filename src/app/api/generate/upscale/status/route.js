import { NextResponse } from "next/server";
import { getItem } from "@/lib/store-db";
import { getSession } from "@/lib/auth";
import { advanceMagnificStatus, assertMagnificItem } from "@/lib/magnific-status-advancement";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(req) {
  const user = await getSession();
  if (!user) {
    return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  }

  const id = req.nextUrl.searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "Missing id parameter." }, { status: 400 });
  }

  const item = await getItem(id);
  if (!item) {
    return NextResponse.json({ error: "Generation not found." }, { status: 404 });
  }

  try { assertMagnificItem(item); }
  catch { return NextResponse.json({ error: "Generation is not a Magnific job." }, { status: 400 }); }

  if (item.status === "succeeded" || item.status === "failed") {
    return NextResponse.json(item, { headers: { "Cache-Control": "no-store" } });
  }

  if (item.userId !== user.id && user.role !== "admin") {
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
  }

  try {
    const result = await advanceMagnificStatus(item);
    const current = result.kind === "raced" ? await getItem(id) : result.item;
    return NextResponse.json(current, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[generate/upscale/status] Error:", e);
    // Transient failure checking provider, return item with last state
    return NextResponse.json(item, { headers: { "Cache-Control": "no-store" } });
  }
}
