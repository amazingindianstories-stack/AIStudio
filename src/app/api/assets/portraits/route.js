import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { logActivity } from "@/lib/activity";
import {
  listPortraitGroups,
  upsertPortraitGroup,
  deletePortraitGroup,
  getPortraitGroup,
} from "@/lib/portrait-db";
import { byteplusAssetClient, BytePlusAssetError } from "@/lib/byteplus-assets";
import { deleteAssetImage } from "@/lib/save-media";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * GET /api/assets/portraits
 * Lists all portrait character groups with active/processing counts and assets.
 */
export async function GET() {
  const user = await getSession();
  if (!user) {
    return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  }

  try {
    const groups = await listPortraitGroups();
    return NextResponse.json({ groups });
  } catch (err) {
    console.error("[portraits] GET error:", err);
    return NextResponse.json(
      { error: err?.message || "Failed to list portrait groups." },
      { status: 500 }
    );
  }
}

/**
 * POST /api/assets/portraits
 * Creates a new character asset group locally and in BytePlus ModelArk.
 * Body: { name, description }
 */
export async function POST(req) {
  const user = await getSession();
  if (!user) {
    return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const name = (body.name || "").trim();
  const description = (body.description || "").trim();

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
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    await logActivity(user.id, "create_portrait_group", {
      id,
      byteplusGroupId: byteplusRes.Id,
      name,
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
 * DELETE /api/assets/portraits?id=<groupId>
 * Deletes a character group and its assets from BytePlus and local storage.
 */
export async function DELETE(req) {
  const user = await getSession();
  if (!user) {
    return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  }

  const id = req.nextUrl.searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "Missing group id." }, { status: 400 });
  }

  try {
    const existing = await getPortraitGroup(id);
    if (!existing) {
      return NextResponse.json({ error: "Character group not found." }, { status: 404 });
    }

    // 1. Delete group in BytePlus (which also cleans up upstream assets)
    if (existing.byteplusGroupId) {
      try {
        await byteplusAssetClient.deleteAssetGroup(existing.byteplusGroupId);
      } catch (bpErr) {
        console.warn("[portraits] BytePlus DeleteAssetGroup failed (non-fatal):", bpErr?.message);
      }
    }

    // 2. Clean up media storage files
    for (const asset of existing.assets || []) {
      if (asset.imageUrl) {
        await deleteAssetImage(asset.imageUrl).catch(() => {});
      }
    }

    // 3. Delete from DB (cascading deletes child assets)
    await deletePortraitGroup(id);

    await logActivity(user.id, "delete_portrait_group", {
      id,
      byteplusGroupId: existing.byteplusGroupId,
      name: existing.name,
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[portraits] DELETE error:", err);
    return NextResponse.json(
      { error: err?.message || "Failed to delete character group." },
      { status: 500 }
    );
  }
}
