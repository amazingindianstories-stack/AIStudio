import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { logActivity } from "@/lib/activity";
import {
  getPortraitGroup,
  upsertPortraitGroup,
  listPortraitAssets,
  getPortraitAsset,
  upsertPortraitAsset,
  deletePortraitAsset,
  updatePortraitAssetStatus,
} from "@/lib/portrait-db";
import {
  byteplusAssetClient,
  validatePortraitImage,
  BytePlusAssetError,
} from "@/lib/byteplus-assets";
import { saveAssetImage, deleteAssetImage } from "@/lib/save-media";
import { splitDataUrl, signStoredRef } from "@/lib/storage";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * GET /api/assets/portraits/[id]/assets
 * Lists assets for a character group and polls status for any in-flight "Processing" assets.
 */
export async function GET(req, { params }) {
  const user = await getSession();
  if (!user) {
    return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  }

  const { id } = await params;
  if (!id) {
    return NextResponse.json({ error: "Missing group id." }, { status: 400 });
  }

  try {
    const group = await getPortraitGroup(id);
    if (!group) {
      return NextResponse.json({ error: "Character group not found." }, { status: 404 });
    }

    let assets = await listPortraitAssets(id);

    // Poll any processing assets against BytePlus
    const pending = assets.filter((a) => a.status === "Processing" && a.byteplusAssetId);
    if (pending.length > 0) {
      await Promise.allSettled(
        pending.map(async (asset) => {
          try {
            const bpAsset = await byteplusAssetClient.getAsset(asset.byteplusAssetId);
            if (bpAsset && bpAsset.Status && bpAsset.Status !== asset.status) {
              await updatePortraitAssetStatus(
                asset.byteplusAssetId,
                bpAsset.Status,
                bpAsset.StatusMessage || bpAsset.ErrorMessage || null
              );
            }
          } catch (pollErr) {
            console.warn(`[portraits] Failed to poll status for asset ${asset.byteplusAssetId}:`, pollErr?.message);
          }
        })
      );
      // Re-read updated list
      assets = await listPortraitAssets(id);
    }

    return NextResponse.json({ assets });
  } catch (err) {
    console.error("[portraits/assets] GET error:", err);
    return NextResponse.json(
      { error: err?.message || "Failed to load assets." },
      { status: 500 }
    );
  }
}

/**
 * POST /api/assets/portraits/[id]/assets
 * Uploads, pre-validates, and registers a portrait reference image with BytePlus ModelArk.
 * Body: { dataUrl, name, role }
 */
export async function POST(req, { params }) {
  const user = await getSession();
  if (!user) {
    return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  }

  const { id } = await params;
  if (!id) {
    return NextResponse.json({ error: "Missing group id." }, { status: 400 });
  }

  const group = await getPortraitGroup(id);
  if (!group) {
    return NextResponse.json({ error: "Character group not found." }, { status: 404 });
  }

  const body = await req.json().catch(() => ({}));
  const dataUrl = body.dataUrl;
  const name = (body.name || "").trim() || "Portrait Reference";
  const role = body.role || "reference"; // 'full_body' | 'close_up' | 'reference'

  if (!dataUrl || typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) {
    return NextResponse.json({ error: "Valid image data URL is required." }, { status: 400 });
  }

  try {
    // 1. Decode & validate image buffer against BytePlus Doc 2333565 requirements
    const { data: base64Data } = splitDataUrl(dataUrl);
    const buffer = Buffer.from(base64Data, "base64");
    const imageInfo = await validatePortraitImage(buffer);

    // 2. Persist to storage
    const savedPath = await saveAssetImage(dataUrl);

    // 3. Mint fetchable URL for BytePlus
    const signedUrl = await signStoredRef(savedPath);

    // 4. Submit to BytePlus ModelArk Asset API (CreateAsset)
    const bpRes = await byteplusAssetClient.createAsset({
      groupId: group.byteplusGroupId,
      url: signedUrl,
      name,
      assetType: "Image",
    });

    // 5. Store in local DB
    const assetId = crypto.randomUUID();
    const now = Date.now();
    const asset = await upsertPortraitAsset({
      id: assetId,
      groupId: id,
      byteplusAssetId: bpRes.Id,
      name,
      assetType: "Image",
      role,
      imageUrl: savedPath,
      // If mock returned immediate active status, honor it; otherwise default to Processing
      status: bpRes.Status || "Processing",
      createdAt: now,
      updatedAt: now,
    });

    // If group has no primary avatar, set this as primary
    if (!group.primaryAssetId) {
      await upsertPortraitGroup({
        ...group,
        primaryAssetId: savedPath,
        updatedAt: now,
      });
    }

    await logActivity(user.id, "upload_portrait_asset", {
      assetId,
      groupId: id,
      byteplusAssetId: bpRes.Id,
      name,
      format: imageInfo.format,
      resolution: `${imageInfo.width}x${imageInfo.height}`,
    });

    return NextResponse.json(asset);
  } catch (err) {
    console.error("[portraits/assets] POST error:", err);
    const status = err instanceof BytePlusAssetError ? err.status : 500;
    return NextResponse.json(
      { error: err?.message || "Failed to upload portrait asset." },
      { status }
    );
  }
}

/**
 * DELETE /api/assets/portraits/[id]/assets?assetId=<assetId>
 * Deletes an individual portrait asset from BytePlus and storage.
 */
export async function DELETE(req, { params }) {
  const user = await getSession();
  if (!user) {
    return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  }

  const { id } = await params;
  const assetId = req.nextUrl.searchParams.get("assetId");

  if (!id || !assetId) {
    return NextResponse.json({ error: "Missing group id or asset id." }, { status: 400 });
  }

  try {
    const asset = await getPortraitAsset(assetId);
    if (!asset || asset.groupId !== id) {
      return NextResponse.json({ error: "Asset not found in group." }, { status: 404 });
    }

    // 1. Delete from BytePlus
    if (asset.byteplusAssetId) {
      try {
        await byteplusAssetClient.deleteAsset(asset.byteplusAssetId);
      } catch (bpErr) {
        console.warn(`[portraits] BytePlus DeleteAsset failed (non-fatal):`, bpErr?.message);
      }
    }

    // 2. Clean up media storage
    if (asset.imageUrl) {
      await deleteAssetImage(asset.imageUrl).catch(() => {});
    }

    // 3. Delete from DB
    await deletePortraitAsset(assetId);

    // If this was primaryAssetId, update group
    const group = await getPortraitGroup(id);
    if (group && group.primaryAssetId === asset.imageUrl) {
      const remaining = await listPortraitAssets(id);
      await upsertPortraitGroup({
        ...group,
        primaryAssetId: remaining[0]?.imageUrl || null,
        updatedAt: Date.now(),
      });
    }

    await logActivity(user.id, "delete_portrait_asset", {
      assetId,
      groupId: id,
      byteplusAssetId: asset.byteplusAssetId,
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[portraits/assets] DELETE error:", err);
    return NextResponse.json(
      { error: err?.message || "Failed to delete asset." },
      { status: 500 }
    );
  }
}
