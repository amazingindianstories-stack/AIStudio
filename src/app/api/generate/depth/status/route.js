import { NextResponse } from "next/server";
import { getItem } from "@/lib/store-db";
import { getSession } from "@/lib/auth";

export const runtime = "nodejs";

/**
 * Plain read, unlike generate/video/status — that route actively advances a
 * provider task on every poll (there's a remote job to check in on). A
 * depth job's state only ever changes because the worker itself wrote it
 * (claim/progress/complete), so this route has nothing to *do*, only to
 * report — matching the shape store.js's poller already expects (item.id +
 * whatever changed, spread into patchEverywhere) so no depth-specific
 * branch is needed there beyond picking which status URL to poll.
 */
export async function GET(req) {
  const user = await getSession();
  if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id is required." }, { status: 400 });

  const item = await getItem(id);
  if (!item || item.kind !== "depth") {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  return NextResponse.json(item);
}
