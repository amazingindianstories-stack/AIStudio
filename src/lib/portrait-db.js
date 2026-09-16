import { eq, desc, asc } from "drizzle-orm";
import { getDb } from "./db";
import { portraitGroups, portraitAssets } from "./schema";

function rowToGroup(r) {
  return {
    id: r.id,
    byteplusGroupId: r.byteplusGroupId ?? undefined,
    name: r.name,
    description: r.description ?? undefined,
    groupType: r.groupType,
    projectName: r.projectName,
    primaryAssetId: r.primaryAssetId ?? undefined,
    createdAt: Number(r.createdAt),
    updatedAt: Number(r.updatedAt),
  };
}

function rowToAsset(r) {
  return {
    id: r.id,
    groupId: r.groupId,
    byteplusAssetId: r.byteplusAssetId ?? undefined,
    name: r.name ?? undefined,
    assetType: r.assetType,
    role: r.role,
    imageUrl: r.imageUrl,
    status: r.status,
    statusMessage: r.statusMessage ?? undefined,
    createdAt: Number(r.createdAt),
    updatedAt: Number(r.updatedAt),
  };
}

export async function listPortraitGroups() {
  const db = await getDb();
  const groups = await db.select().from(portraitGroups).orderBy(desc(portraitGroups.createdAt));
  const assets = await db.select().from(portraitAssets).orderBy(asc(portraitAssets.createdAt));

  const assetsByGroup = new Map();
  for (const asset of assets) {
    const arr = assetsByGroup.get(asset.groupId) ?? [];
    arr.push(rowToAsset(asset));
    assetsByGroup.set(asset.groupId, arr);
  }

  return groups.map((g) => {
    const groupAssets = assetsByGroup.get(g.id) ?? [];
    return {
      ...rowToGroup(g),
      assets: groupAssets,
      activeCount: groupAssets.filter((a) => a.status === "Active").length,
      processingCount: groupAssets.filter((a) => a.status === "Processing").length,
    };
  });
}

export async function getPortraitGroup(id) {
  const db = await getDb();
  const rows = await db.select().from(portraitGroups).where(eq(portraitGroups.id, id)).limit(1);
  if (!rows[0]) return undefined;
  const assets = await db
    .select()
    .from(portraitAssets)
    .where(eq(portraitAssets.groupId, id))
    .orderBy(asc(portraitAssets.createdAt));
  const group = rowToGroup(rows[0]);
  return {
    ...group,
    assets: assets.map(rowToAsset),
    activeCount: assets.filter((a) => a.status === "Active").length,
    processingCount: assets.filter((a) => a.status === "Processing").length,
  };
}

export async function getPortraitGroupByByteplusId(byteplusGroupId) {
  const db = await getDb();
  const rows = await db
    .select()
    .from(portraitGroups)
    .where(eq(portraitGroups.byteplusGroupId, byteplusGroupId))
    .limit(1);
  return rows[0] ? rowToGroup(rows[0]) : undefined;
}

export async function upsertPortraitGroup(group) {
  const db = await getDb();
  const now = Date.now();
  const values = {
    id: group.id,
    byteplusGroupId: group.byteplusGroupId ?? null,
    name: group.name,
    description: group.description ?? null,
    groupType: group.groupType || "AIGC",
    projectName: group.projectName || "default",
    primaryAssetId: group.primaryAssetId ?? null,
    createdAt: group.createdAt || now,
    updatedAt: group.updatedAt || now,
  };
  await db
    .insert(portraitGroups)
    .values(values)
    .onConflictDoUpdate({ target: portraitGroups.id, set: values });
  return getPortraitGroup(group.id);
}

export async function deletePortraitGroup(id) {
  const db = await getDb();
  const existing = await getPortraitGroup(id);
  if (!existing) return undefined;
  await db.delete(portraitGroups).where(eq(portraitGroups.id, id));
  return existing;
}

export async function listPortraitAssets(groupId) {
  const db = await getDb();
  const rows = await db
    .select()
    .from(portraitAssets)
    .where(eq(portraitAssets.groupId, groupId))
    .orderBy(asc(portraitAssets.createdAt));
  return rows.map(rowToAsset);
}

export async function getPortraitAsset(id) {
  const db = await getDb();
  const rows = await db.select().from(portraitAssets).where(eq(portraitAssets.id, id)).limit(1);
  return rows[0] ? rowToAsset(rows[0]) : undefined;
}

export async function getPortraitAssetByByteplusId(byteplusAssetId) {
  const db = await getDb();
  const rows = await db
    .select()
    .from(portraitAssets)
    .where(eq(portraitAssets.byteplusAssetId, byteplusAssetId))
    .limit(1);
  return rows[0] ? rowToAsset(rows[0]) : undefined;
}

export async function getPortraitAssetByImageUrl(imageUrl) {
  const db = await getDb();
  const rows = await db
    .select()
    .from(portraitAssets)
    .where(eq(portraitAssets.imageUrl, imageUrl))
    .limit(1);
  return rows[0] ? rowToAsset(rows[0]) : undefined;
}

export async function upsertPortraitAsset(asset) {
  const db = await getDb();
  const now = Date.now();
  const values = {
    id: asset.id,
    groupId: asset.groupId,
    byteplusAssetId: asset.byteplusAssetId ?? null,
    name: asset.name ?? null,
    assetType: asset.assetType || "Image",
    role: asset.role || "reference",
    imageUrl: asset.imageUrl,
    status: asset.status || "Processing",
    statusMessage: asset.statusMessage ?? null,
    createdAt: asset.createdAt || now,
    updatedAt: asset.updatedAt || now,
  };
  await db
    .insert(portraitAssets)
    .values(values)
    .onConflictDoUpdate({ target: portraitAssets.id, set: values });
  return getPortraitAsset(asset.id);
}

export async function updatePortraitAssetStatus(byteplusAssetId, status, statusMessage = null) {
  const db = await getDb();
  const now = Date.now();
  await db
    .update(portraitAssets)
    .set({
      status,
      statusMessage,
      updatedAt: now,
    })
    .where(eq(portraitAssets.byteplusAssetId, byteplusAssetId));
  return getPortraitAssetByByteplusId(byteplusAssetId);
}

export async function deletePortraitAsset(id) {
  const db = await getDb();
  const existing = await getPortraitAsset(id);
  if (!existing) return undefined;
  await db.delete(portraitAssets).where(eq(portraitAssets.id, id));
  return existing;
}
