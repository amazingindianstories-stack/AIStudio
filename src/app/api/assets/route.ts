import { NextRequest, NextResponse } from "next/server";
import {
  readAssets,
  upsertAsset,
  getAsset,
  deleteAsset,
  makeUniqueSlug,
} from "@/lib/assets-db";
import { saveAssetImage, deleteAssetImage } from "@/lib/save-media";
import { ASSET_KINDS, type Asset, type AssetKind } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET() {
  const assets = await readAssets();
  return NextResponse.json({ assets });
}

/**
 * Create or update an asset.
 * Body: { id?, kind, name, description?, images: string[] }
 * `images` may mix existing public paths (/assets/…) and new data URLs; new
 * data URLs are saved to disk and replaced with their public path.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const name: string = (body.name || "").trim();
  const kind: AssetKind = body.kind;
  const description: string = (body.description || "").trim();
  const inputImages: string[] = Array.isArray(body.images) ? body.images : [];

  if (!name) {
    return NextResponse.json({ error: "Name is required." }, { status: 400 });
  }
  if (!ASSET_KINDS.includes(kind)) {
    return NextResponse.json({ error: "Invalid asset kind." }, { status: 400 });
  }

  const existing = body.id ? await getAsset(body.id) : undefined;

  // Persist any newly-uploaded images (data URLs) to disk; keep existing paths.
  const images: string[] = [];
  for (const img of inputImages) {
    if (typeof img !== "string") continue;
    if (img.startsWith("data:")) images.push(await saveAssetImage(img));
    else images.push(img);
  }

  // Clean up images that were removed during an edit.
  if (existing) {
    const kept = new Set(images);
    for (const old of existing.images) {
      if (!kept.has(old)) await deleteAssetImage(old);
    }
  }

  const now = Date.now();
  const asset: Asset = {
    id: existing?.id ?? crypto.randomUUID(),
    kind,
    name,
    slug: existing?.slug ?? (await makeUniqueSlug(name)),
    description: description || undefined,
    images,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  await upsertAsset(asset);
  return NextResponse.json(asset);
}

export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "Missing id." }, { status: 400 });
  }
  const removed = await deleteAsset(id);
  if (removed) {
    for (const img of removed.images) await deleteAssetImage(img);
  }
  return NextResponse.json({ ok: true });
}
