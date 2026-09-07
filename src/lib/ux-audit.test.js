import { handoffManifest } from "./handoff";
import { describe, expect, test, vi, afterEach } from "vitest";
import {
  composerSnapshot,
  modeTransition,
  modelTransition,
  restoreComposerSnapshot,
} from "./composer-state";
import { composerEstimate } from "./composer-estimate";
import { generationError } from "./generation-error";
import { statusEvidence } from "./status-evidence";
import { requestJson } from "./api";
import { historyFilterToParams, parseHistoryFilter } from "./history-query";
import {
  matchesScope,
  scopeKey,
  scopeToQuery,
  compareInScope,
} from "./feed-scope";
import { renumberImgMentions } from "./mentions";

const draft = {
  mode: "video",
  model: "Seedance 2.0",
  aspectRatio: "16:9",
  resolution: "720p",
  duration: 8,
  batchCount: 3,
  generateAudio: true,
  videoTaskMode: "generate",
  prompt: "A camera move @img1 @vid1",
  referenceImages: ["image-a"],
  referenceKinds: ["image"],
  referenceLabels: ["Costume"],
  referenceVideos: ["clip-a"],
  stagedReferenceVideos: [],
  continuationFrame: null,
  stagedContinuationFrame: null,
  seed: 42,
  audioNotes: [],
  productionContext: { sourceGenerationId: "source" },
  modeDrafts: {},
  modelPreferences: {},
};
afterEach(() => vi.unstubAllGlobals());
describe("composer draft integrity", () => {
  test("round trips preserve independent prompts, settings and references", () => {
    const image = { ...draft, ...modeTransition(draft, "image") };
    image.prompt = "Portrait";
    image.referenceImages = ["face"];
    const video = { ...image, ...modeTransition(image, "video") };
    expect(composerSnapshot(video)).toEqual(composerSnapshot(draft));
    const imageAgain = { ...video, ...modeTransition(video, "image") };
    expect(imageAgain.prompt).toBe("Portrait");
    expect(imageAgain.referenceImages).toEqual(["face"]);
    expect(modeTransition(video, "video")).toEqual({});
  });
  test("unsupported clips are recoverable after switching back", () => {
    const changed = {
      ...draft,
      ...modelTransition(draft, "Gemini Omni Flash"),
    };
    expect(changed.stagedReferenceVideos).toEqual(["clip-a"]);
    expect(changed.referenceVideos).toEqual([]);
    expect(changed.composerNotice).toContain("preserved");
    const restored = { ...changed, ...modelTransition(changed, draft.model) };
    expect(restored.referenceVideos).toEqual(["clip-a"]);
    expect(restored.duration).toBe(8);
    expect(restored.generateAudio).toBe(true);
  });
  test("removing a reference cannot silently retarget its mention", () => {
    expect(renumberImgMentions("@img1 beside @img2", [-1, 0])).toBe(
      "[removed reference] beside @img1",
    );
  });
});
describe("honest configured estimates", () => {
  test("missing rates differ from deliberately configured zero", () => {
    expect(composerEstimate(draft, []).available).toBe(false);
    const input = { model: "Nano Banana Pro", resolution: "1K", batchCount: 2 };
    expect(
      composerEstimate(input, [
        { model: input.model, unit: "per_image", unitCostCents: 0 },
      ]).totalCents,
    ).toBe(0);
  });
  test("audio and batch use the configured per-output calculation", () => {
    const result = composerEstimate(
      { ...draft, duration: 5, batchCount: 2, resolution: "720p" },
      [
        { model: draft.model, unit: "per_second", unitCostCents: 10 },
        { model: "Seedance 2.0 · audio", unit: "per_second", unitCostCents: 2 },
      ],
    );
    expect(result).toMatchObject({
      available: true,
      baseCents: 50,
      audioCents: 10,
      totalCents: 120,
    });
  });
  test("editing duration and missing surcharges are not guessed", () => {
    expect(
      composerEstimate({ ...draft, videoTaskMode: "edit" }, []).available,
    ).toBe(false);
    expect(
      composerEstimate(draft, [
        { model: draft.model, unit: "per_second", unitCostCents: 10 },
      ]).available,
    ).toBe(false);
  });
});
test.each([400, 403, 500])(
  "HTTP %i cannot report save success",
  async (status) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: "Save rejected" }), { status }),
      ),
    );
    await expect(
      requestJson("/api/example", { method: "POST" }),
    ).rejects.toThrow("Save rejected");
  },
);
test("network errors propagate without a fake success", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("Offline");
    }),
  );
  await expect(requestJson("/api/example")).rejects.toThrow("Offline");
});
test("scope identity, membership and ordering carry every retrieval filter", () => {
  const scope = {
    tab: "history",
    kind: "all",
    q: "scene one",
    model: "Nano Banana Pro",
    from: "2026-09-05",
    to: "2026-09-05",
    reviewStatus: "approved",
    sort: "oldest",
  };
  const item = {
    id: "a",
    kind: "image",
    model: scope.model,
    prompt: "portrait",
    createdAt: Date.parse("2026-09-05T23:59:59Z"),
    productionMetadata: { scene: "Scene one", reviewStatus: "approved" },
  };
  expect(matchesScope(item, scope)).toBe(true);
  expect(
    matchesScope(
      { ...item, createdAt: Date.parse("2026-09-06T00:00:00Z") },
      scope,
    ),
  ).toBe(false);
  expect(scopeKey(scope)).not.toBe(scopeKey({ ...scope, sort: "" }));
  expect(
    parseHistoryFilter(historyFilterToParams(scopeToQuery(scope))),
  ).toEqual({
    model: scope.model,
    q: scope.q,
    from: scope.from,
    to: scope.to,
    reviewStatus: scope.reviewStatus,
    sort: scope.sort,
  });
  expect(
    compareInScope(
      item,
      { ...item, id: "b", createdAt: item.createdAt + 1 },
      scope,
    ),
  ).toBeLessThan(0);
});
test("provider configuration and account errors do not imply operational success", () => {
  expect(statusEvidence({ id: "seedance", status: "ok" }).kind).toBe(
    "configured",
  );
  expect(
    generationError({ error: "Account overdue: request 123" }).action,
  ).toContain("Changing the prompt will not");
  expect(generationError({ error: "503 timeout" }).category).toContain(
    "Temporary",
  );
});

test("restoring an old draft validates settings and keeps its text and references", () => {
  const restored = restoreComposerSnapshot("video", {
    ...draft,
    resolution: "invalid",
    duration: 999,
    batchCount: 100,
  });
  expect(restored.prompt).toBe(draft.prompt);
  expect(restored.referenceImages).toEqual(draft.referenceImages);
  expect(restored.resolution).not.toBe("invalid");
  expect(restored.duration).toBeLessThan(999);
  expect(restored.batchCount).toBe(1);
  expect(
    restoreComposerSnapshot("video", { ...draft, referenceImages: [null] }),
  ).toBeNull();
});

test("handoff preserves the selected order, lineage and reviewer metadata", () => {
  const first = {
    id: "take-b",
    url: "/media/b.mp4",
    productionMetadata: {
      sourceGenerationId: "take-a",
      reviewStatus: "approved",
      review: { reviewerName: "Director" },
    },
    seed: 42,
    referenceImages: ["/ref.png"],
  };
  const second = { id: "take-a", url: "/media/a.png" };
  const manifest = JSON.parse(
    JSON.stringify(
      handoffManifest(
        [first, second],
        "https://studio.example",
        "2026-09-07T00:00:00Z",
      ),
    ),
  );
  expect(manifest.takes.map((take) => [take.order, take.id])).toEqual([
    [1, "take-b"],
    [2, "take-a"],
  ]);
  expect(manifest.takes[0]).toMatchObject({
    mediaUrl: "https://studio.example/media/b.mp4",
    seed: 42,
    referenceImages: ["/ref.png"],
    productionMetadata: first.productionMetadata,
  });
  expect(manifest.description).toContain("not embedded");
});
