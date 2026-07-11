import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getItem } from "@/lib/store-db";
import { createZipArchive } from "@/lib/zip";

export const runtime = "nodejs";

function extensionFromContentType(contentType: string | null, fallbackUrl: string): string {
  const type = (contentType || "").toLowerCase();
  if (type.includes("png")) return "png";
  if (type.includes("webp")) return "webp";
  if (type.includes("gif")) return "gif";
  if (type.includes("jpeg") || type.includes("jpg")) return "jpg";
  if (type.includes("avif")) return "avif";
  if (type.includes("mp4")) return "mp4";
  const urlExt = fallbackUrl.split("?")[0].split(".").pop()?.toLowerCase();
  return urlExt && urlExt.length <= 5 ? urlExt : "bin";
}

export async function POST(req: NextRequest) {
  if (!(await getSession())) {
    return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const ids = Array.isArray(body.ids)
    ? body.ids.filter((id: unknown): id is string => typeof id === "string" && id.trim().length > 0)
    : [];

  if (ids.length === 0) {
    return NextResponse.json({ error: "No items selected." }, { status: 400 });
  }

  const entries: Array<{ name: string; data: Uint8Array }> = [];
  const selectedItems = await Promise.all(ids.map((id: string) => getItem(id)));

  for (let index = 0; index < selectedItems.length; index++) {
    const item = selectedItems[index];
    if (!item?.url || item.kind !== "image") continue;

    const res = await fetch(item.url);
    if (!res.ok) continue;
    const bytes = new Uint8Array(await res.arrayBuffer());
    const ext = extensionFromContentType(res.headers.get("content-type"), item.url);
    entries.push({
      name: `${String(index + 1).padStart(2, "0")}-${item.id}.${ext}`,
      data: bytes,
    });
  }

  if (!entries.length) {
    return NextResponse.json({ error: "No downloadable images found." }, { status: 400 });
  }

  const zip = createZipArchive(entries);
  const filename = `assets-${new Date().toISOString().slice(0, 10)}.zip`;

  return new NextResponse(Buffer.from(zip), {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": String(zip.length),
      "Cache-Control": "no-store",
    },
  });
}
