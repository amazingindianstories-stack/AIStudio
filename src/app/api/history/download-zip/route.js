import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getItem } from "@/lib/store-db";
import { createZipArchive } from "@/lib/zip";
import { mediaKeyFromRef, readStoredBuffer } from "@/lib/storage";
import { extensionFromBytes } from "@/lib/media-sniff";

export const runtime = "nodejs";

export async function POST(req) {
  if (!(await getSession())) {
    return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const ids = Array.isArray(body.ids)
    ? body.ids.filter((id) => typeof id === "string" && id.trim().length > 0)
    : [];

  if (ids.length === 0) {
    return NextResponse.json({ error: "No items selected." }, { status: 400 });
  }

  const entries = [];
  const selectedItems = await Promise.all(ids.map((id) => getItem(id)));

  for (let index = 0; index < selectedItems.length; index++) {
    const item = selectedItems[index];
    if (!item?.url || item.kind !== "image") continue;

    // Read straight from the storage backend (S3/GCS) rather than fetching
    // `item.url` over HTTP: that URL is the app-relative `/api/media/...`
    // proxy path, which Node's fetch cannot resolve without a base, and the
    // proxy also requires a forwarded session cookie this server-side call
    // doesn't have.
    const key = mediaKeyFromRef(item.url);
    if (!key) continue;
    let bytes;
    try {
      bytes = await readStoredBuffer(key);
    } catch {
      continue;
    }
    // Sniff the format from the actual bytes rather than the URL — see
    // media-sniff.js's docstring for why the old null-content-type call
    // here silently produced ".bin" for extensionless storage keys.
    const ext = extensionFromBytes(bytes, item.url);
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
