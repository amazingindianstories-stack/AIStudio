import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { logActivity } from "@/lib/activity";
import {
  upsertPortraitGroup,
  deletePortraitGroup,
  getPortraitGroup,
  deletePortraitAsset,
  getPortraitAsset,
  getPortraitAssetByByteplusId,
  updatePortraitAssetName,
} from "@/lib/portrait-db";
import { byteplusAssetClient, BytePlusAssetError } from "@/lib/byteplus-assets";
import { deleteAssetImage } from "@/lib/save-media";

import { syncByteplusPortraits } from "@/lib/portrait-sync";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * GET /api/assets/portraits
 * Lists all portrait character groups and all flat portrait assets,
 * syncing bidirectionally with BytePlus ModelArk when credentials are present.
 */
export async function GET(req) {
  const user = await getSession();
  if (!user) {
    return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  }

  const { searchParams } = new URL(req?.url || "http://localhost");
  const projectId = searchParams.get("projectId") || undefined;

  try {
    const result = await syncByteplusPortraits(projectId);
    return NextResponse.json(result);
  } catch (err) {
    console.error("[portraits] GET error:", err);
    return NextResponse.json(
      { error: err?.message || "Failed to list portraits." },
      { status: 500 }
    );
  }
}

/**
 * POST /api/assets/portraits
 * Creates a new character asset group.
 * Body: { name, description, projectId? }
 */
export async function POST(req) {
  const user = await getSession();
  if (!user) {
    return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const name = (body.name || "").trim();
  const description = (body.description || "").trim();
  const projectId = body.projectId || undefined;

  if (!name) {
    return NextResponse.json({ error: "Character name is required." }, { status: 400 });
  }

  try {
    // 1. Create group in BytePlus ModelArk (or mock simulator)
    const byteplusRes = await byteplusAssetClient.createAssetGroup({
      name,
      description,
      groupType: "AIGC",
    });

    // 2. Persist locally
    const id = crypto.randomUUID();
    const group = await upsertPortraitGroup({
      id,
      byteplusGroupId: byteplusRes.Id,
      name,
      description,
      groupType: "AIGC",
      projectName: "default",
      projectId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    await logActivity(user.id, "create_portrait_group", {
      id,
      byteplusGroupId: byteplusRes.Id,
      name,
      projectId,
    });

    return NextResponse.json(group);
  } catch (err) {
    console.error("[portraits] POST error:", err);
    const status = err instanceof BytePlusAssetError ? err.status : 500;
    return NextResponse.json(
      { error: err?.message || "Failed to create character group." },
      { status }
    );
  }
}

/**
 * PATCH /api/assets/portraits
 * Updates asset name: { assetId, name } or character group name: { groupId, name }
 */
export async function PATCH(req) {
  const user = await getSession();
  if (!user) {
    return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const assetId = body.assetId;
  const groupId = body.groupId;
  const name = (body.name || "").trim();

  if ((!assetId && !groupId) || !name) {
    return NextResponse.json({ error: "assetId or groupId, and name are required." }, { status: 400 });
  }

  try {
    if (groupId) {
      const existing = await getPortraitGroup(groupId);
      if (!existing) {
        return NextResponse.json({ error: "Character group not found." }, { status: 404 });
      }
      const updated = await upsertPortraitGroup({
        ...existing,
        name,
        updatedAt: Date.now(),
      });
      await logActivity(user.id, "rename_portrait_group", { id: groupId, name });
      return NextResponse.json({ ok: true, group: updated });
    }

    const updated = await updatePortraitAssetName(assetId, name);
    if (!updated) {
      return NextResponse.json({ error: "Asset not found." }, { status: 404 });
    }
    await logActivity(user.id, "rename_portrait_asset", { id: assetId, name });
    return NextResponse.json({ ok: true, asset: updated });
  } catch (err) {
    console.error("[portraits] PATCH error:", err);
    return NextResponse.json(
      { error: err?.message || "Failed to update resource." },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/assets/portraits?id=<groupId> OR ?assetId=<assetId>
 * Deletes a character group or individual portrait asset.
 */
export async function DELETE(req) {
  const user = await getSession();
  if (!user) {
    return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  }

  const assetId = req.nextUrl.searchParams.get("assetId");
  const groupId = req.nextUrl.searchParams.get("id");

  if (!assetId && !groupId) {
    return NextResponse.json({ error: "Missing assetId or id parameter." }, { status: 400 });
  }

  try {
    if (assetId) {
      let asset = await getPortraitAsset(assetId);
      if (!asset) {
        asset = await getPortraitAssetByByteplusId(assetId);
      }

      if (!asset) {
        // If not in DB, but matches byteplus format, try remote deletion
        if (assetId.startsWith("asset-")) {
          try {
            await byteplusAssetClient.deleteAsset(assetId);
          } catch (bpErr) {
            console.warn("[portraits] Direct BytePlus DeleteAsset failed:", bpErr?.message);
          }
        }
        return NextResponse.json({ ok: true, deleted: "already_removed" });
      }

      const bpId = asset.byteplusAssetId || (assetId.startsWith("asset-") ? assetId : null);
      if (bpId) {
        try {
          await byteplusAssetClient.deleteAsset(bpId);
        } catch (bpErr) {
          console.warn("[portraits] BytePlus DeleteAsset failed:", bpErr?.message);
        }
      }

      if (asset.imageUrl) {
        await deleteAssetImage(asset.imageUrl).catch(() => {});
      }

      await deletePortraitAsset(asset.id);
      await logActivity(user.id, "delete_portrait_asset", { id: asset.id, name: asset.name });
      return NextResponse.json({ ok: true });
    }

    // Group deletion
    const existing = await getPortraitGroup(groupId);
    if (!existing) {
      return NextResponse.json({ error: "Character group not found." }, { status: 404 });
    }

    if (existing.byteplusGroupId) {
      try {
        await byteplusAssetClient.deleteAssetGroup(existing.byteplusGroupId);
      } catch (bpErr) {
        console.warn("[portraits] BytePlus DeleteAssetGroup failed (non-fatal):", bpErr?.message);
      }
    }

    for (const asset of existing.assets || []) {
      if (asset.imageUrl) {
        await deleteAssetImage(asset.imageUrl).catch(() => {});
      }
    }

    await deletePortraitGroup(groupId);
    await logActivity(user.id, "delete_portrait_group", {
      id: groupId,
      byteplusGroupId: existing.byteplusGroupId,
      name: existing.name,
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[portraits] DELETE error:", err);
    return NextResponse.json(
      { error: err?.message || "Failed to delete portrait resource." },
      { status: 500 }
    );
  }
}
