import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "./db";
import { portraitGroups, portraitAssets } from "./schema";
import {
  listPortraitGroups,
  getPortraitGroup,
  upsertPortraitGroup,
  deletePortraitGroup,
  listPortraitAssets,
  getPortraitAsset,
  upsertPortraitAsset,
  updatePortraitAssetStatus,
  deletePortraitAsset,
  getPortraitAssetByImageUrl,
} from "./portrait-db";

test("portrait-db: CRUD operations, cascading assets, and image URL lookup", async () => {
  assert.ok(process.env.DATABASE_URL, "test:db requires a disposable PostgreSQL database");

  const db = await getDb();
  const groupId = randomUUID();
  const assetId1 = randomUUID();
  const assetId2 = randomUUID();
  const bpGroupId = `bp_grp_${randomUUID().slice(0, 8)}`;
  const bpAssetId1 = `bp_ast_${randomUUID().slice(0, 8)}`;
  const bpAssetId2 = `bp_ast_${randomUUID().slice(0, 8)}`;
  const testImageUrl1 = `/api/media/test-${assetId1}.png`;
  const testImageUrl2 = `/api/media/test-${assetId2}.png`;

  try {
    // 1. Create a character group
    const createdGroup = await upsertPortraitGroup({
      id: groupId,
      byteplusGroupId: bpGroupId,
      name: "Integration Test Character",
      description: "A character for DB integration testing",
      groupType: "AIGC",
      projectName: "default",
    });

    assert.equal(createdGroup.id, groupId);
    assert.equal(createdGroup.name, "Integration Test Character");
    assert.equal(createdGroup.byteplusGroupId, bpGroupId);
    assert.equal(createdGroup.assets.length, 0);
    assert.equal(createdGroup.activeCount, 0);
    assert.equal(createdGroup.processingCount, 0);

    const allGroups = await listPortraitGroups();
    assert.ok(allGroups.some((g) => g.id === groupId));

    // 2. Add two assets to the character group
    const asset1 = await upsertPortraitAsset({
      id: assetId1,
      groupId,
      byteplusAssetId: bpAssetId1,
      name: "Full Body Shot",
      assetType: "Image",
      role: "full_body",
      imageUrl: testImageUrl1,
      status: "Processing",
    });

    assert.equal(asset1.id, assetId1);
    assert.equal(asset1.status, "Processing");
    assert.equal(asset1.role, "full_body");

    const fetchedAsset = await getPortraitAsset(assetId1);
    assert.equal(fetchedAsset.id, assetId1);

    const asset2 = await upsertPortraitAsset({
      id: assetId2,
      groupId,
      byteplusAssetId: bpAssetId2,
      name: "Close-up Portrait",
      assetType: "Image",
      role: "close_up",
      imageUrl: testImageUrl2,
      status: "Active",
    });

    assert.equal(asset2.id, assetId2);
    assert.equal(asset2.status, "Active");

    // 3. Verify getPortraitGroup counts active and processing correctly
    const groupWithAssets = await getPortraitGroup(groupId);
    assert.equal(groupWithAssets.assets.length, 2);
    assert.equal(groupWithAssets.activeCount, 1);
    assert.equal(groupWithAssets.processingCount, 1);

    // 4. Update asset 1 status to Active
    const updatedAsset1 = await updatePortraitAssetStatus(bpAssetId1, "Active", "Asset successfully processed");
    assert.equal(updatedAsset1.status, "Active");
    assert.equal(updatedAsset1.statusMessage, "Asset successfully processed");

    const refreshedGroup = await getPortraitGroup(groupId);
    assert.equal(refreshedGroup.activeCount, 2);
    assert.equal(refreshedGroup.processingCount, 0);

    // 5. Lookup by imageUrl
    const foundByUrl = await getPortraitAssetByImageUrl(testImageUrl2);
    assert.ok(foundByUrl);
    assert.equal(foundByUrl.id, assetId2);
    assert.equal(foundByUrl.byteplusAssetId, bpAssetId2);

    // 6. Delete individual asset
    const deletedAsset = await deletePortraitAsset(assetId1);
    assert.equal(deletedAsset.id, assetId1);

    const remainingAssets = await listPortraitAssets(groupId);
    assert.equal(remainingAssets.length, 1);
    assert.equal(remainingAssets[0].id, assetId2);

    // 7. Delete group and verify cascade
    await deletePortraitGroup(groupId);
    const nonExistentGroup = await getPortraitGroup(groupId);
    assert.equal(nonExistentGroup, undefined);

    const orphanedAssets = await db
      .select()
      .from(portraitAssets)
      .where(eq(portraitAssets.groupId, groupId));
    assert.equal(orphanedAssets.length, 0, "Assets should be deleted via cascade");
  } finally {
    // Cleanup in case of test failure
    try {
      await db.delete(portraitAssets).where(eq(portraitAssets.groupId, groupId));
      await db.delete(portraitGroups).where(eq(portraitGroups.id, groupId));
    } catch {
      // ignore
    }
  }
});
