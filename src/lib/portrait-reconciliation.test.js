import test from "node:test";
import assert from "node:assert/strict";
import { listAllByteplusPages, unlinkedGlobalCandidate, isDurablePortraitRef } from "./portrait-reconciliation.js";

test("BytePlus inventory exhausts three pages, deduplicates IDs and sorts deterministically", async () => {
  const calls = [];
  const result = await listAllByteplusPages(async ({ nextToken }) => {
    calls.push(nextToken);
    const page = nextToken ? Number(nextToken) : 0;
    return { Items: Array.from({ length: 100 }, (_, i) => ({ Id: `id-${String(page * 90 + i).padStart(3, "0")}` })),
      NextToken: page < 2 ? String(page + 1) : "" };
  });
  assert.deepEqual(calls, [undefined, "1", "2"]);
  assert.equal(result.pages, 3);
  assert.equal(result.items.length, 280);
  assert.equal(result.items[0].Id, "id-000");
  assert.equal(result.items.at(-1).Id, "id-279");
});
test("BytePlus pagination rejects loops, bounds, invalid pages and incomplete discovery", async () => {
  await assert.rejects(listAllByteplusPages(async () => ({ Items: [], NextToken: "loop" })), /Repeated/);
  await assert.rejects(listAllByteplusPages(async () => ({ Items: [], NextToken: "next" }), {}, { maxPages: 1 }), /page limit/);
  await assert.rejects(listAllByteplusPages(async () => ({})), /Invalid/);
  await assert.rejects(listAllByteplusPages(async () => ({ Items: [{}] })), /no ID/);
  await assert.rejects(listAllByteplusPages(async ({ nextToken }) => {
    if (nextToken) throw new Error("transport failure");
    return { Items: [{ Id: "a" }], NextToken: "second" };
  }), /transport failure/);
});
test("same-name matching is global-only, unique and never crosses project scopes", () => {
  const groups = [
    { id: "global", name: "General Portraits" },
    { id: "a", name: "General Portraits", projectId: "a" },
    { id: "b", name: "General Portraits", projectId: "b" },
  ];
  const remote = { Id: "remote", Name: "General Portraits" };
  assert.equal(unlinkedGlobalCandidate(groups, remote, [remote]).id, "global");
  assert.equal(unlinkedGlobalCandidate(groups.slice(1), remote, [remote]), null);
  assert.equal(unlinkedGlobalCandidate([...groups, groups[0]], remote, [remote]), null);
  assert.equal(unlinkedGlobalCandidate(groups, remote, [remote, { ...remote, Id: "another" }]), null);
});
test("durable portrait references distinguish owned storage from transient provider URLs", () => {
  const env = { GCP_MEDIA_BUCKET: "owned", GCP_MEDIA_CDN_URL: "https://media.example.com", AWS_S3_BUCKET_NAME: "owned-s3" };
  for (const ref of ["/api/media/portraits/a.png", "https://storage.googleapis.com/owned/a.png", "https://owned.storage.googleapis.com/a.png", "https://media.example.com/a.png", "https://owned-s3.s3.amazonaws.com/a.png"]) {
    assert.equal(isDurablePortraitRef(ref, env), true, ref);
  }
  for (const ref of ["https://tos-provider.example.com/a.png?token=expired", "https://storage.googleapis.com/other/a.png", "https://owned-s3.s3.evil.example/a.png"]) {
    assert.equal(isDurablePortraitRef(ref, env), false, ref);
  }
});
