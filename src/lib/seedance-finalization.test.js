import assert from "node:assert/strict";
import test from "node:test";
import { buildFinalGeneration, canFinalizeDraft, DRAFT_FINALIZATION_TTL_MS, validateDraftForFinalization } from "./seedance-finalization";

const now = 2_000_000_000_000;
const valid = {
  id: "source",
  kind: "video",
  model: "Seedance 2.5",
  draftMode: true,
  status: "succeeded",
  taskId: "provider-task",
  createdAt: now - 1_000,
};

test("completed Seedance 2.5 drafts remain eligible for seven days", () => {
  assert.equal(canFinalizeDraft(valid, now), true);
  assert.equal(canFinalizeDraft({ ...valid, createdAt: now - DRAFT_FINALIZATION_TTL_MS }, now), true);
});

test("draft finalization rejects every invalid source class", () => {
  const cases = [
    [undefined, /not found/i],
    [{ ...valid, kind: "image" }, /video drafts/i],
    [{ ...valid, draftMode: false }, /not a draft/i],
    [{ ...valid, model: "Seedance 2.0" }, /Seedance 2.5/i],
    [{ ...valid, status: "running" }, /finish successfully/i],
    [{ ...valid, taskId: undefined }, /provider task ID/i],
    [{ ...valid, createdAt: now - DRAFT_FINALIZATION_TTL_MS - 1 }, /older than seven days/i],
  ];
  for (const [source, expected] of cases) {
    assert.match(validateDraftForFinalization(source, now), expected);
  }
});

test("final row is linked, queued, 1080p, and preserves source display placement", () => {
  const source = { ...valid, prompt: "shot", aspectRatio: "21:9", duration: 8, projectId: "p", folderId: "f", referenceImages: ["ref"] };
  const snapshot = structuredClone(source);
  const child = buildFinalGeneration(source, { id: "child", userId: "teammate", costCents: 123, now });
  assert.deepEqual(source, snapshot, "building a final must not mutate its draft");
  assert.deepEqual(
    { status: child.status, resolution: child.resolution, sourceGenerationId: child.sourceGenerationId, draftTaskId: child.draftTaskId, projectId: child.projectId, folderId: child.folderId, prompt: child.prompt },
    { status: "queued", resolution: "1080p", sourceGenerationId: "source", draftTaskId: "provider-task", projectId: "p", folderId: "f", prompt: "shot" }
  );
});
