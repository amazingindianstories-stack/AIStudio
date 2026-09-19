import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import {
  signByteplusRequest,
  validatePortraitImage,
  byteplusAssetClient,
  resetMockStore,
  BytePlusAssetError,
  MIN_ASPECT_RATIO,
  MAX_ASPECT_RATIO,
} from "./byteplus-assets.js";

test("signByteplusRequest: formats OpenAPI v4 authorization header correctly", () => {
  const date = new Date("2026-09-16T12:00:00Z");
  const result = signByteplusRequest({
    method: "POST",
    pathname: "/",
    query: { Version: "2024-01-01", Action: "CreateAssetGroup" },
    headers: { "content-type": "application/json", host: "ark.ap-southeast-1.byteplusapi.com" },
    body: JSON.stringify({ Name: "test-group" }),
    ak: "TEST_ACCESS_KEY",
    sk: "TEST_SECRET_KEY",
    region: "ap-southeast-1",
    service: "ark",
    date,
  });

  assert.equal(result.xDate, "20260916T120000Z");
  assert.match(
    result.headers.Authorization,
    /^HMAC-SHA256 Credential=TEST_ACCESS_KEY\/20260916\/ap-southeast-1\/ark\/request, SignedHeaders=[\w;.-]+, Signature=[0-9a-f]{64}$/
  );
  assert.equal(result.headers["x-date"], "20260916T120000Z");
  assert.equal(typeof result.headers["x-content-sha256"], "string");
  assert.equal(result.headers["x-content-sha256"].length, 64);
});

test("validatePortraitImage: accepts a compliant PNG buffer", async () => {
  const validBuffer = await sharp({
    create: {
      width: 500,
      height: 750, // aspect ratio = 0.67 (between 0.4 and 2.5)
      channels: 3,
      background: { r: 100, g: 150, b: 200 },
    },
  })
    .png()
    .toBuffer();

  const info = await validatePortraitImage(validBuffer);
  assert.equal(info.width, 500);
  assert.equal(info.height, 750);
  assert.equal(info.format, "png");
  assert.ok(info.ratio >= MIN_ASPECT_RATIO && info.ratio <= MAX_ASPECT_RATIO);
});

test("validatePortraitImage: rejects empty or corrupted buffers", async () => {
  await assert.rejects(
    validatePortraitImage(Buffer.alloc(0)),
    (err) => err instanceof BytePlusAssetError && err.code === "invalid_image"
  );

  await assert.rejects(
    validatePortraitImage(Buffer.from("not an image")),
    (err) => err instanceof BytePlusAssetError && err.code === "decode_failed"
  );
});

test("validatePortraitImage: rejects dimensions below 300px or above 6000px", async () => {
  const tooSmallBuffer = await sharp({
    create: {
      width: 250,
      height: 250,
      channels: 3,
      background: { r: 255, g: 0, b: 0 },
    },
  })
    .png()
    .toBuffer();

  await assert.rejects(
    validatePortraitImage(tooSmallBuffer),
    (err) => err instanceof BytePlusAssetError && err.code === "dimensions_out_of_bounds"
  );
});

test("validatePortraitImage: rejects extreme aspect ratios", async () => {
  // width/height = 1000 / 300 = 3.33 (exceeds 2.5)
  const tooWideBuffer = await sharp({
    create: {
      width: 1000,
      height: 300,
      channels: 3,
      background: { r: 0, g: 255, b: 0 },
    },
  })
    .png()
    .toBuffer();

  await assert.rejects(
    validatePortraitImage(tooWideBuffer),
    (err) => err instanceof BytePlusAssetError && err.code === "invalid_aspect_ratio"
  );

  // width/height = 300 / 1000 = 0.3 (below 0.4)
  const tooTallBuffer = await sharp({
    create: {
      width: 300,
      height: 1000,
      channels: 3,
      background: { r: 0, g: 0, b: 255 },
    },
  })
    .png()
    .toBuffer();

  await assert.rejects(
    validatePortraitImage(tooTallBuffer),
    (err) => err instanceof BytePlusAssetError && err.code === "invalid_aspect_ratio"
  );
});

test("byteplusAssetClient: executes complete group and asset lifecycle in mock mode", async () => {
  resetMockStore();

  // 1. Create group
  const groupRes = await byteplusAssetClient.createAssetGroup({
    name: "Hero Character",
    description: "Main persona for sci-fi scenes",
  });
  assert.ok(groupRes.Id);
  assert.match(groupRes.Id, /^group-/);

  // 2. List groups
  const groupList = await byteplusAssetClient.listAssetGroups();
  assert.equal(groupList.Items.length, 1);
  assert.equal(groupList.Items[0].Id, groupRes.Id);
  assert.equal(groupList.Items[0].Name, "Hero Character");

  // 3. Create asset in group
  const assetRes = await byteplusAssetClient.createAsset({
    groupId: groupRes.Id,
    url: "https://storage.veevee.ai/references/hero-fullbody.png",
    name: "hero-fullbody",
    assetType: "Image",
  });
  assert.ok(assetRes.Id);
  assert.match(assetRes.Id, /^asset-/);

  // 4. Get asset details
  const assetDetails = await byteplusAssetClient.getAsset(assetRes.Id);
  assert.equal(assetDetails.Id, assetRes.Id);
  assert.equal(assetDetails.GroupId, groupRes.Id);
  assert.equal(assetDetails.Status, "Active");

  // 5. List assets by groupId
  const assetsList = await byteplusAssetClient.listAssets({ groupIds: [groupRes.Id] });
  assert.equal(assetsList.Items.length, 1);
  assert.equal(assetsList.Items[0].Id, assetRes.Id);

  // 6. Delete asset
  const delAsset = await byteplusAssetClient.deleteAsset(assetRes.Id);
  assert.equal(delAsset.Id, assetRes.Id);

  const afterAssetDel = await byteplusAssetClient.listAssets({ groupIds: [groupRes.Id] });
  assert.equal(afterAssetDel.Items.length, 0);

  // 7. Delete group
  const delGroup = await byteplusAssetClient.deleteAssetGroup(groupRes.Id);
  assert.equal(delGroup.Id, groupRes.Id);

  const afterGroupDel = await byteplusAssetClient.listAssetGroups();
  assert.equal(afterGroupDel.Items.length, 0);
});
