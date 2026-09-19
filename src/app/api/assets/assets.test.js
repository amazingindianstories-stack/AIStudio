import test from "node:test";
import assert from "node:assert/strict";
import { GET, POST, DELETE } from "./route.js";

test("Assets API: unauthenticated requests fail with 401 UNAUTHENTICATED", async () => {
  // GET without projectId
  const getRes = await GET();
  assert.equal(getRes.status, 401);
  const getJson = await getRes.json();
  assert.equal(getJson.error, "UNAUTHENTICATED");

  // GET with projectId query param
  const scopedGetReq = new Request("http://localhost/api/assets?projectId=00000000-0000-0000-0000-000000000001");
  const scopedGetRes = await GET(scopedGetReq);
  assert.equal(scopedGetRes.status, 401);
  const scopedGetJson = await scopedGetRes.json();
  assert.equal(scopedGetJson.error, "UNAUTHENTICATED");

  // POST with projectId
  const postReq = new Request("http://localhost/api/assets", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "Sati",
      kind: "character",
      image: "data:image/png;base64,AA==",
      projectId: "00000000-0000-0000-0000-000000000001",
    }),
  });
  const postRes = await POST(postReq);
  assert.equal(postRes.status, 401);
  const postJson = await postRes.json();
  assert.equal(postJson.error, "UNAUTHENTICATED");

  // DELETE
  const delReq = new Request("http://localhost/api/assets?id=some-id", {
    method: "DELETE",
  });
  const delRes = await DELETE(delReq);
  assert.equal(delRes.status, 401);
  const delJson = await delRes.json();
  assert.equal(delJson.error, "UNAUTHENTICATED");
});

test("Assets DB: rowToAsset preserves projectId", async () => {
  const { rowToAsset } = await import("@/lib/assets-db.js");
  const mapped = rowToAsset({
    id: "asset-1",
    kind: "character",
    name: "Sati",
    slug: "sati",
    description: "Heroine",
    image: "/api/media/sati.png",
    projectId: "00000000-0000-0000-0000-000000000001",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
  });
  assert.equal(mapped.projectId, "00000000-0000-0000-0000-000000000001");
  assert.equal(mapped.name, "Sati");
  assert.equal(mapped.slug, "sati");
});
