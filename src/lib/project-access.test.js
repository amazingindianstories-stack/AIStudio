import test from "node:test";
import assert from "node:assert/strict";
import { askProjectAccess, projectAccessLabel, settleProjectAccess, useProjectAccessRequest, PROJECT_ACCESS_OPTIONS } from "./project-access.js";

test("access modes are all, users and admin", () => {
  assert.deepEqual(PROJECT_ACCESS_OPTIONS.map((o) => o.value), ["all", "users", "admin"]);
  assert.equal(projectAccessLabel("admin"), "Admin only");
  assert.equal(projectAccessLabel("unknown"), "Everyone");
});

test("the dialog resolves with the chosen access and is a no-op without a host", async () => {
  assert.equal(await askProjectAccess({ title: "x" }), null);
  useProjectAccessRequest.setState({ hostMounted: true });
  const pending = askProjectAccess({ title: "x", askName: true });
  settleProjectAccess({ name: "P", access: "users", accessUserIds: ["u1"] });
  assert.deepEqual(await pending, { name: "P", access: "users", accessUserIds: ["u1"] });
});
