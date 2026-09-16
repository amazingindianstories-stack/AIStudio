import test from "node:test";
import assert from "node:assert/strict";
import { GET as listPortraits, POST as createPortraitGroup, DELETE as deletePortraitGroup } from "./route.js";
import {
  GET as listGroupAssets,
  POST as uploadGroupAsset,
  DELETE as deleteGroupAsset,
} from "./[id]/assets/route.js";

// Ensure tests fail closed on unauthenticated requests
test("Portraits API: all routes require valid session authentication", async () => {
  // 1. GET /api/assets/portraits
  const getRes = await listPortraits();
  assert.equal(getRes.status, 401);
  const getJson = await getRes.json();
  assert.equal(getJson.error, "UNAUTHENTICATED");

  // 2. POST /api/assets/portraits
  const postReq = new Request("http://localhost/api/assets/portraits", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Elena" }),
  });
  const postRes = await createPortraitGroup(postReq);
  assert.equal(postRes.status, 401);
  const postJson = await postRes.json();
  assert.equal(postJson.error, "UNAUTHENTICATED");

  // 3. DELETE /api/assets/portraits
  const delReq = new Request("http://localhost/api/assets/portraits?id=test-id", {
    method: "DELETE",
  });
  const delRes = await deletePortraitGroup(delReq);
  assert.equal(delRes.status, 401);
  const delJson = await delRes.json();
  assert.equal(delJson.error, "UNAUTHENTICATED");

  // 4. GET /api/assets/portraits/[id]/assets
  const getAssetsRes = await listGroupAssets(new Request("http://localhost/api/assets/portraits/123/assets"), {
    params: Promise.resolve({ id: "123" }),
  });
  assert.equal(getAssetsRes.status, 401);

  // 5. POST /api/assets/portraits/[id]/assets
  const postAssetRes = await uploadGroupAsset(
    new Request("http://localhost/api/assets/portraits/123/assets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dataUrl: "data:image/png;base64,AA==" }),
    }),
    { params: Promise.resolve({ id: "123" }) }
  );
  assert.equal(postAssetRes.status, 401);

  // 6. DELETE /api/assets/portraits/[id]/assets
  const delAssetRes = await deleteGroupAsset(
    new Request("http://localhost/api/assets/portraits/123/assets?assetId=456", {
      method: "DELETE",
    }),
    { params: Promise.resolve({ id: "123" }) }
  );
  assert.equal(delAssetRes.status, 401);
});

test("syncByteplusPortraits: falls back safely to local store when mock/unconfigured", async () => {
  const { syncByteplusPortraits } = await import("@/lib/portrait-sync.js");
  const result = await syncByteplusPortraits();
  assert.ok(Array.isArray(result.groups));
  assert.ok(Array.isArray(result.assets));
  assert.equal(typeof result.syncedWithByteplus, "boolean");
});
