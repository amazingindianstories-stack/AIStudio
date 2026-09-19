import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { logActivity } from "@/lib/activity";
import {
  ensureDefaultPortraitGroup,
  upsertPortraitAsset,
  getPortraitGroup,
  upsertPortraitGroup,
} from "@/lib/portrait-db";
import {
  byteplusAssetClient,
  validatePortraitImage,
  BytePlusAssetError,
  getByteplusConfig,
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
  const projectId = body.projectId || undefined;

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
      group = await ensureDefaultPortraitGroup(projectId);
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
    const bpConfig = getByteplusConfig();
    try {
      if (!group.byteplusGroupId) {
        // Try finding existing group on BytePlus first (e.g. "General Portraits")
        try {
          const bpGroupsRes = await byteplusAssetClient.listAssetGroups({
            groupType: "AIGC",
            projectName: "default",
            maxResults: 50,
          });
          const existingBpGroup = bpGroupsRes?.Items?.find(
            (g) => g.Name === (group.name || "General Portraits")
          ) || bpGroupsRes?.Items?.[0];

          if (existingBpGroup?.Id) {
            group.byteplusGroupId = existingBpGroup.Id;
          }
        } catch {
          // Fall through to create
        }

        if (!group.byteplusGroupId) {
          const bpGroupRes = await byteplusAssetClient.createAssetGroup({
            name: group.name || "General Portraits",
            description: group.description || "Virtual Portrait Group",
            groupType: "AIGC",
            projectName: "default",
          });
          if (bpGroupRes?.Id) {
            group.byteplusGroupId = bpGroupRes.Id;
          }
        }

        if (group.byteplusGroupId) {
          group = await upsertPortraitGroup({
            ...group,
            byteplusGroupId: group.byteplusGroupId,
            updatedAt: Date.now(),
          });
          groupId = group.id;
        }
      }

      if (group.byteplusGroupId) {
        const signedUrl = (await signStoredRef(savedPath)) || savedPath;
        const bpRes = await byteplusAssetClient.createAsset({
          groupId: group.byteplusGroupId,
          url: signedUrl,
          name,
          assetType: "Image",
        });
        bpAssetId = bpRes?.Id || null;
        if (bpRes?.Status) {
          initialStatus = bpRes.Status;
        }
      }
    } catch (bpErr) {
      if (!bpConfig.isMock) {
        console.error("[portraits/upload] BytePlus CreateAsset failed in production:", bpErr);
        throw bpErr;
      }
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
