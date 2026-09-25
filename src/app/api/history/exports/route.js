import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { createMediaExport } from "@/lib/media-exports-db";

export const runtime = "nodejs";
export async function POST() {
  const user = await getSession();
  if (!user) return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  return NextResponse.json(await createMediaExport(user.id), { status: 201 });
}
