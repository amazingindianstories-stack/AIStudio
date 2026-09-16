import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { logActivity } from "@/lib/activity";
import {
  ensureDefaultPortraitGroup,
  upsertPortraitAsset,
  getPortraitGroup,
} from "@/lib/portrait-db";
import {
  byteplusAssetClient,
  validatePortraitImage,
  BytePlusAssetError,
} from "@/lib/byteplus-assets";
import { saveAssetImage } from "@/lib/save-media";
import { splitDataUrl, signStoredRef } from "@/lib/storage";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * POST /api/assets/portraits/upload
 * Directly upload and register a portrait image.
 * Accepts: { dataUrl, name?, role?, groupId? }
 */
export async function POST(req) {
  const user = await getSession();
  if (!user) {
    return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const dataUrl = body.dataUrl;
  const rawName = (body.name || "").trim();
  const name = rawName || "Portrait";
  const role = body.role || "reference";
  let groupId = body.groupId;

  if (!dataUrl || typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) {
    return NextResponse.json(
      { error: "Valid image data URL is required." },
      { status: 400 }
    );
  }

  try {
    // 1. Resolve or create parent group automatically
    let group;
    if (groupId) {
      group = await getPortraitGroup(groupId);
    }
    if (!group) {
      group = await ensureDefaultPortraitGroup();
      groupId = group.id;
    }

    // 2. Decode and validate image buffer
    const { data: base64Data } = splitDataUrl(dataUrl);
    const buffer = Buffer.from(base64Data, "base64");
    await validatePortraitImage(buffer);

    // 3. Persist image to media storage
    const savedPath = await saveAssetImage(dataUrl);

    // 4. Create in BytePlus ModelArk
    let bpAssetId = null;
    let initialStatus = "Active";
    try {
      if (!group.byteplusGroupId) {
        const bpGroupRes = await byteplusAssetClient.createAssetGroup({
          name: group.name || "Default Character",
          description: group.description || "Virtual Portrait Group",
          groupType: "AIGC",
        });
        if (bpGroupRes?.Id) {
          group.byteplusGroupId = bpGroupRes.Id;
          await upsertPortraitGroup({
            ...group,
            byteplusGroupId: bpGroupRes.Id,
            updatedAt: Date.now(),
          });
        }
      }

      if (group.byteplusGroupId) {
        const signedUrl = await signStoredRef(savedPath);
        const bpRes = await byteplusAssetClient.createAsset({
          groupId: group.byteplusGroupId,
          url: signedUrl,
          name,
          assetType: "Image",
        });
        bpAssetId = bpRes?.Id || null;
      }
    } catch (bpErr) {
      console.warn("[portraits/upload] BytePlus CreateAsset skipped or mock:", bpErr?.message);
    }

    // 5. Store in database
    const assetId = crypto.randomUUID();
    const now = Date.now();
    const asset = await upsertPortraitAsset({
      id: assetId,
      groupId,
      byteplusAssetId: bpAssetId,
      name,
      assetType: "Image",
      role,
      imageUrl: savedPath,
      status: initialStatus,
      statusMessage: null,
      createdAt: now,
      updatedAt: now,
    });

    await logActivity(user.id, "upload_portrait_asset", {
      id: assetId,
      name,
      imageUrl: savedPath,
    });

    return NextResponse.json({ ok: true, asset });
  } catch (err) {
    console.error("[portraits/upload] error:", err);
    const status = err instanceof BytePlusAssetError ? err.status : 500;
    return NextResponse.json(
      { error: err?.message || "Failed to upload portrait." },
      { status }
    );
  }
}
