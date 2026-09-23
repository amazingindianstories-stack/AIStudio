import test from "node:test";
import assert from "node:assert/strict";
import {
  clearMaterialCache,
  dedupeMaterialRequest,
  dropMaterialCaches,
  getMaterialCache,
  isMaterialFresh,
  materialKey,
  patchMaterialCaches,
  putMaterialCache,
} from "./material-cache";

test("material keys normalize the all-project scope", () => {
  assert.equal(materialKey(), "__all__");
  assert.equal(materialKey(null), "__all__");
  assert.equal(materialKey("p1"), "p1");
});

test("material requests collapse across startup and modal open", async () => {
  clearMaterialCache();
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const run = () => dedupeMaterialRequest("p1", async () => { calls++; await gate; return []; });
  const startup = run();
  const modal = run();
  assert.equal(startup, modal);
  release();
  await startup;
  assert.equal(calls, 1);
});

test("material cache freshness and mutations remain project-aware", () => {
  clearMaterialCache();
  putMaterialCache("__all__", { items: [], at: 100 });
  putMaterialCache("p1", { items: [], at: 100 });
  putMaterialCache("p2", { items: [], at: 100 });
  const asset = { id: "a", projectId: "p1" };
  patchMaterialCaches(asset);
  assert.deepEqual(getMaterialCache("__all__").items, [asset]);
  assert.deepEqual(getMaterialCache("p1").items, [asset]);
  assert.deepEqual(getMaterialCache("p2").items, []);
  assert.equal(isMaterialFresh(getMaterialCache("p1"), 30_099), true);
  assert.equal(isMaterialFresh(getMaterialCache("p1"), 30_100), false);
  dropMaterialCaches("a");
  assert.deepEqual(getMaterialCache("p1").items, []);
});
