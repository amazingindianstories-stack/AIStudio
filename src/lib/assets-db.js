import { eq, desc } from "drizzle-orm";
import { getDb } from "./db";
import { assets } from "./schema";

/** Reusable reference assets — Postgres (was assets.json). Dormant in the UI. */

function rowToAsset(r) {
  return {
    id: r.id,
    kind: r.kind ,
    name: r.name,
    slug: r.slug,
    description: r.description ?? undefined,
    images: r.images ?? [],
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export async function readAssets() {
  const db = await getDb();
  const rows = await db.select().from(assets).orderBy(desc(assets.createdAt));
  return rows.map(rowToAsset);
}

export async function getAsset(id) {
  const db = await getDb();
  const rows = await db.select().from(assets).where(eq(assets.id, id)).limit(1);
  return rows[0] ? rowToAsset(rows[0]) : undefined;
}

export async function upsertAsset(asset) {
  const db = await getDb();
  const values = {
    id: asset.id,
    kind: asset.kind,
    name: asset.name,
    slug: asset.slug,
    description: asset.description ?? null,
    images: asset.images,
    createdAt: asset.createdAt,
    updatedAt: asset.updatedAt,
  };
  await db
    .insert(assets)
    .values(values)
    .onConflictDoUpdate({ target: assets.id, set: values });
}

export async function deleteAsset(id) {
  const db = await getDb();
  const rows = await db.delete(assets).where(eq(assets.id, id)).returning();
  return rows[0] ? rowToAsset(rows[0]) : undefined;
}

export async function makeUniqueSlug(
  name,
  excludeId
) {
  const base =
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "asset";
  const all = await readAssets();
  const taken = new Set(all.filter((a) => a.id !== excludeId).map((a) => a.slug));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}
