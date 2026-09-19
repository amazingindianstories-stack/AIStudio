import test from "node:test";
import assert from "node:assert/strict";
import { GET, POST, DELETE } from "./route.js";

test("Assets API: unauthenticated requests fail with 401 UNAUTHENTICATED", async () => {
  // GET
  const getRes = await GET();
  assert.equal(getRes.status, 401);
  const getJson = await getRes.json();
  assert.equal(getJson.error, "UNAUTHENTICATED");

  // POST
  const postReq = new Request("http://localhost/api/assets", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Sati", kind: "character", image: "data:image/png;base64,AA==" }),
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
