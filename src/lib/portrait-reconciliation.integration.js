import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { getDb } from "./db.js";
import { projects, portraitGroups } from "./schema.js";
import { upsertPortraitGroup, upsertPortraitAsset, getPortraitAsset, getPortraitGroup,
  listPortraitGroups, listAllPortraitAssets, ensureDefaultPortraitGroup } from "./portrait-db.js";
import { byteplusAssetClient } from "./byteplus-assets.js";
import { syncByteplusPortraits, inventoryByteplusPortraits } from "./portrait-sync.js";

test("portrait visibility preserves global/A/B scopes and refuses destructive identity collisions", async () => {
  const db = await getDb();
  const projectIds = [randomUUID(), randomUUID()];
  const groupIds = [randomUUID(), randomUUID(), randomUUID()];
  const assetIds = groupIds.map(() => randomUUID());
  const remoteIds = groupIds.map(() => `group-${randomUUID()}`);
  const now = Date.now();
  await db.insert(projects).values(projectIds.map((id) => ({ id, name: id, createdAt: now, updatedAt: now })));
  try {
    for (let i = 0; i < 3; i++) {
      await upsertPortraitGroup({ id: groupIds[i], name: "General Portraits", projectId: i ? projectIds[i - 1] : null, byteplusGroupId: remoteIds[i] });
      await upsertPortraitAsset({ id: assetIds[i], groupId: groupIds[i], byteplusAssetId: `asset-${randomUUID()}`, imageUrl: `/api/media/${i}.png`, status: "Active" });
    }
    for (let i = 0; i < 2; i++) {
      const groups = await listPortraitGroups(projectIds[i]);
      assert.ok(groups.some((g) => g.id === groupIds[0]));
      assert.ok(groups.some((g) => g.id === groupIds[i + 1]));
      assert.ok(!groups.some((g) => g.id === groupIds[2 - i]));
      const assets = await listAllPortraitAssets(projectIds[i]);
      assert.ok(assets.some((a) => a.id === assetIds[0]));
      assert.ok(!assets.some((a) => a.id === assetIds[2 - i]));
    }
    const globalDefault = await ensureDefaultPortraitGroup();
    assert.equal(globalDefault.projectId, undefined);
    await assert.rejects(upsertPortraitGroup({ id: groupIds[2], name: "General Portraits", projectId: projectIds[1], byteplusGroupId: remoteIds[0] }), { code: "PORTRAIT_IDENTITY_CONFLICT" });
    for (let i = 0; i < 3; i++) {
      assert.equal((await getPortraitGroup(groupIds[i])).byteplusGroupId, remoteIds[i]);
      assert.equal((await getPortraitAsset(assetIds[i])).groupId, groupIds[i]);
    }
  } finally {
    await db.delete(portraitGroups).where(inArray(portraitGroups.id, groupIds));
    await db.delete(projects).where(inArray(projects.id, projectIds));
  }
});

test("real sync exhausts remote pages, preserves identities and durable URLs, and does not delete absent records", async () => {
  const db = await getDb();
  const tag = randomUUID();
  const originals = { ...byteplusAssetClient };
  const envKeys = ["NODE_ENV", "MOCK_ASSET_PROVIDER", "MOCK_GENERATION", "BYTEPLUS_ACCESS_KEY_ID", "BYTEPLUS_SECRET_ACCESS_KEY"];
  const envBefore = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, { NODE_ENV: "development", MOCK_ASSET_PROVIDER: "0", MOCK_GENERATION: "0", BYTEPLUS_ACCESS_KEY_ID: "fixture-ak", BYTEPLUS_SECRET_ACCESS_KEY: "fixture-sk" });
  const groups = Array.from({ length: 3 }, (_, i) => ({ Id: `${tag}-group-${i}`, Name: "General Portraits" }));
  const assets = Array.from({ length: 205 }, (_, i) => ({ Id: `${tag}-asset-${i}`, GroupId: groups[i % 3].Id,
    URL: `https://tos.example.com/${i}.png?fixture=refreshed`, Status: "Active" }));
  const ownerIds = [randomUUID(), randomUUID(), randomUUID()];
  const projectId = randomUUID();
  const durableId = randomUUID();
  const absentId = randomUUID();
  const now = Date.now();
  await db.insert(projects).values({ id: projectId, name: tag, createdAt: now, updatedAt: now });
  try {
    for (let i = 0; i < groups.length; i++) await upsertPortraitGroup({ id: ownerIds[i], name: groups[i].Name, byteplusGroupId: groups[i].Id, projectId: i ? projectId : null });
    await upsertPortraitAsset({ id: durableId, groupId: ownerIds[0], byteplusAssetId: assets[0].Id, imageUrl: "/api/media/portraits/durable.png", status: "Active" });
    await upsertPortraitAsset({ id: absentId, groupId: ownerIds[0], byteplusAssetId: `${tag}-absent`, imageUrl: "/api/media/portraits/absent.png", status: "Active" });
    let groupCalls = 0; let assetCalls = 0;
    byteplusAssetClient.listAssetGroups = async ({ nextToken }) => {
      groupCalls++; const i = nextToken ? Number(nextToken) : 0;
      return { Items: [groups[i]], NextToken: i < 2 ? String(i + 1) : "" };
    };
    byteplusAssetClient.listAssets = async ({ nextToken }) => {
      assetCalls++; const i = nextToken ? Number(nextToken) : 0;
      return { Items: assets.slice(i * 100, (i + 1) * 100), NextToken: i < 2 ? String(i + 1) : "" };
    };
    for (const key of ["deleteAsset", "deleteAssetGroup", "createAsset", "createAssetGroup"]) {
      byteplusAssetClient[key] = async () => { throw new Error(`Unexpected remote mutation: ${key}`); };
    }
    const first = await syncByteplusPortraits(projectId);
    assert.equal(first.syncedWithByteplus, true);
    assert.equal(first.inventory.assetPages, 3);
    const firstIds = first.assets.filter((a) => a.byteplusAssetId?.startsWith(tag)).map((a) => a.id).sort();
    assert.equal(firstIds.length, 206);
    assert.equal((await getPortraitAsset(durableId)).imageUrl, "/api/media/portraits/durable.png");
    assert.ok(await getPortraitAsset(absentId));
    const second = await syncByteplusPortraits(projectId);
    assert.deepEqual(second.assets.filter((a) => a.byteplusAssetId?.startsWith(tag)).map((a) => a.id).sort(), firstIds);
    assert.equal(groupCalls, 6); assert.equal(assetCalls, 6);
    const inventory = await inventoryByteplusPortraits();
    assert.equal(inventory.remote.assetPages, 3);
    assert.deepEqual(inventory.localAssetsMissingRemotely.filter((id) => id.startsWith(tag)), [`${tag}-absent`]);
    assert.equal(inventory.remoteAssetsMissingLocally.length, 0);
    assert.ok(inventory.remote.assets.every((a) => !Object.hasOwn(a, "URL")));
    for (const id of ownerIds) assert.equal((await getPortraitGroup(id)).name, "General Portraits");
    byteplusAssetClient.listAssets = async () => ({ Items: [], NextToken: "loop" });
    const failed = await syncByteplusPortraits(projectId);
    assert.equal(failed.syncedWithByteplus, false);
    assert.match(failed.syncError, /preserved/);
    assert.equal((await listAllPortraitAssets(projectId)).filter((a) => a.byteplusAssetId?.startsWith(tag)).length, 206);
    byteplusAssetClient.listAssets = async () => ({ Items: assets });
    const uncertainId = randomUUID();
    await upsertPortraitAsset({ id: uncertainId, groupId: ownerIds[0], imageUrl: "https://example.com/portrait.png", status: "Active" });
    let creates = 0;
    byteplusAssetClient.createAsset = async () => { creates++; throw new Error("Remote response lost after acceptance"); };
    assert.equal((await syncByteplusPortraits(projectId)).syncedWithByteplus, false);
    assert.equal((await getPortraitAsset(uncertainId)).statusMessage, "registration_outcome_unknown");
    assert.equal((await syncByteplusPortraits(projectId)).syncedWithByteplus, false);
    assert.equal(creates, 1, "unknown remote outcomes must not be blindly recreated");
  } finally {
    Object.assign(byteplusAssetClient, originals);
    for (const key of envKeys) { if (envBefore[key] === undefined) delete process.env[key]; else process.env[key] = envBefore[key]; }
    await db.delete(portraitGroups).where(inArray(portraitGroups.id, ownerIds));
    await db.delete(projects).where(eq(projects.id, projectId));
  }
});
