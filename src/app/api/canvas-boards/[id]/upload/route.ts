import { NextRequest, NextResponse } from "next/server";
import { saveCanvasAsset } from "@/lib/save-media";
import { getSession } from "@/lib/auth";

export const runtime = "nodejs";

/**
 * POST /api/canvas-boards/[id]/upload { dataUrl } -> { url }
 * Direct upload/paste path for placing an image node (design.md: not an
 * acceptance criterion, first thing to cut if scope must shrink — the
 * asset-library drag path is the load-bearing one).
 */
export async function POST(req: NextRequest) {
  if (!(await getSession())) {
    return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  }
  const b = await req.json().catch(() => ({}));
  const dataUrl: string | undefined = b.dataUrl;
  if (!dataUrl || typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) {
    return NextResponse.json({ error: "dataUrl required." }, { status: 400 });
  }
  try {
    const url = await saveCanvasAsset(dataUrl);
    return NextResponse.json({ url });
  } catch {
    return NextResponse.json({ error: "Upload failed." }, { status: 400 });
  }
}
