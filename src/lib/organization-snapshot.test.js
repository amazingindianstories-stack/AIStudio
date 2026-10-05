import test from "node:test";
import assert from "node:assert/strict";
import { compareOrganizationSnapshots } from "../../scripts/snapshot-organization.js";

const baseline = () => ({
  projects: [{ id: "p", name: "Project" }],
  folders: [{ id: "f", name: "Folder", projectId: "p", parentId: null }],
  generations: [{ id: "g", projectId: "p", folderId: "f", mediaRef: "/api/media/a.png" }],
});

test("snapshot preservation accepts unchanged content", () => {
  assert.equal(compareOrganizationSnapshots(baseline(), baseline()).isPreserved, true);
});
for (const collection of ["projects", "folders", "generations"]) {
  for (const mutation of ["add", "remove", "replace", "duplicate"]) {
    test(`snapshot rejects ${mutation} ${collection} IDs`, () => {
      const after = baseline();
      const row = after[collection][0];
      if (mutation === "add") after[collection].push({ ...row, id: "new" });
      if (mutation === "remove") after[collection] = [];
      if (mutation === "replace") row.id = "new";
      if (mutation === "duplicate") after[collection].push({ ...row });
      assert.equal(compareOrganizationSnapshots(baseline(), after).isPreserved, false);
    });
  }
}
for (const [collection, field, value] of [
  ["folders", "projectId", null], ["folders", "parentId", "parent"],
  ["folders", "name", "Renamed"], ["projects", "name", "Renamed"],
  ["generations", "projectId", null], ["generations", "folderId", null],
  ["generations", "mediaRef", "/api/media/changed.png"],
]) {
  test(`snapshot rejects changed ${collection}.${field}`, () => {
    const after = baseline(); after[collection][0][field] = value;
    assert.equal(compareOrganizationSnapshots(baseline(), after).isPreserved, false);
  });
}
test("snapshot fails closed for missing fields and malformed collections", () => {
  for (const bad of [null, {}, { ...baseline(), folders: null }, { ...baseline(), generations: [{ id: "g" }] }]) {
    assert.equal(compareOrganizationSnapshots(baseline(), bad).isPreserved, false);
  }
});
