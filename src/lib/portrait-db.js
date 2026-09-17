import { eq, desc, asc, like, or } from "drizzle-orm";
import { getDb } from "./db.js";
import { portraitGroups, portraitAssets } from "./schema.js";

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
  if (!imageUrl || typeof imageUrl !== "string") return undefined;
  const db = await getDb();

  // 1. Direct exact match
  const exactRows = await db
    .select()
    .from(portraitAssets)
    .where(eq(portraitAssets.imageUrl, imageUrl))
    .limit(1);
  if (exactRows[0]) return rowToAsset(exactRows[0]);

  // 2. Query-string stripped match (for dynamic signed TOS URLs or media URLs with params)
  const cleanUrl = imageUrl.split("?")[0].split("#")[0];
  if (cleanUrl && cleanUrl !== imageUrl) {
    const cleanExactRows = await db
      .select()
      .from(portraitAssets)
      .where(eq(portraitAssets.imageUrl, cleanUrl))
      .limit(1);
    if (cleanExactRows[0]) return rowToAsset(cleanExactRows[0]);

    const prefixRows = await db
      .select()
      .from(portraitAssets)
      .where(like(portraitAssets.imageUrl, `${cleanUrl}%`))
      .limit(1);
    if (prefixRows[0]) return rowToAsset(prefixRows[0]);
  } else {
    // imageUrl had no query params, but DB row might have query params (e.g. TOS URL)
    const prefixRows = await db
      .select()
      .from(portraitAssets)
      .where(like(portraitAssets.imageUrl, `${imageUrl}%`))
      .limit(1);
    if (prefixRows[0]) return rowToAsset(prefixRows[0]);
  }

  // 3. Fallback: match by URL pathname (e.g. /3000924751/091019210558441937.png or /assets/uuid.png)
  try {
    const parsed = new URL(imageUrl, "http://localhost");
    const pathname = parsed.pathname;
    if (pathname && pathname !== "/" && pathname.length > 5) {
      const pathRows = await db
        .select()
        .from(portraitAssets)
        .where(like(portraitAssets.imageUrl, `%${pathname}%`))
        .limit(1);
      if (pathRows[0]) return rowToAsset(pathRows[0]);
    }
  } catch {
    // Ignore invalid URLs
  }

  return undefined;
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
  let existing = await getPortraitAsset(id);
  if (!existing) {
    existing = await getPortraitAssetByByteplusId(id);
  }
  if (!existing) return undefined;
  await db
    .delete(portraitAssets)
    .where(
      or(
        eq(portraitAssets.id, existing.id),
        eq(portraitAssets.id, id),
        eq(portraitAssets.byteplusAssetId, id)
      )
    );
  return existing;
}

export async function listAllPortraitAssets() {
  const db = await getDb();
  const rows = await db
    .select()
    .from(portraitAssets)
    .orderBy(desc(portraitAssets.createdAt));
  return rows.map(rowToAsset);
}

export async function ensureDefaultPortraitGroup() {
  const db = await getDb();
  const rows = await db.select().from(portraitGroups).limit(1);
  if (rows[0]) return rowToGroup(rows[0]);
  const id = crypto.randomUUID();
  const now = Date.now();
  await db.insert(portraitGroups).values({
    id,
    name: "General Portraits",
    description: "Default portrait collection",
    groupType: "AIGC",
    projectName: "default",
    createdAt: now,
    updatedAt: now,
  });
  return getPortraitGroup(id);
}

export async function updatePortraitAssetName(id, name) {
  const db = await getDb();
  const now = Date.now();
  await db
    .update(portraitAssets)
    .set({
      name: name.trim(),
      updatedAt: now,
    })
    .where(eq(portraitAssets.id, id));
  return getPortraitAsset(id);
}

