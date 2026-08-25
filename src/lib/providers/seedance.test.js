/**
 * Tests for the pure/black-box-testable parts of providers/seedance.js.
 *
 * No seedance.test.js existed on the JS side before this — the Django port
 * (test_seedance_provider.py) already covered this ground and says so in its
 * own docstring ("no seedance.test.js exists on the TS side to port, unlike
 * kling/gemini"). This mirrors that file's cases so the two don't drift
 * apart, adapted to this codebase's own convention (kling.test.js) of
 * asserting on the assembled request body rather than mocking a driver
 * object: `pickModel`/`tagsToImageRefs` are module-private here (unlike
 * Python, where leading-underscore names are still directly importable), so
 * their effects are exercised indirectly through createVideoTask's output,
 * the same way kling.test.js exercises buildKlingPayload's callers.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createVideoTask, isModerationMessage, SeedanceError } from "./seedance";

test("isModerationMessage: detects moderation keywords", () => {
  assert.equal(isModerationMessage("SensitiveContent detected"), true);
  assert.equal(isModerationMessage("privacy violation: real person"), true);
  assert.equal(isModerationMessage("portrait flagged"), true);
});

test("isModerationMessage: false for unrelated errors, including empty/nullish input", () => {
  assert.equal(isModerationMessage("InvalidParameter.TaskTypeConstraint"), false);
  assert.equal(isModerationMessage(""), false);
  assert.equal(isModerationMessage(undefined), false);
});

/** Mocks global fetch for one call, capturing the request body, and restores
 *  the original afterward regardless of outcome. */
async function withFakeArkResponse(taskId, run) {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.ARK_API_KEY;
  let capturedBody;
  process.env.ARK_API_KEY = "test-key";
  globalThis.fetch = async (_url, init) => {
    capturedBody = JSON.parse(init.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({ id: taskId }),
      text: async () => JSON.stringify({ id: taskId }),
    };
  };
  try {
    const result = await run();
    return { result, body: capturedBody };
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.ARK_API_KEY;
    else process.env.ARK_API_KEY = originalKey;
  }
}

test("createVideoTask: edit task forces adaptive ratio and duration -1", async () => {
  const { result, body } = await withFakeArkResponse("task123", () =>
    createVideoTask({ prompt: "do the edit", taskMode: "edit", ratio: "16:9", duration: 10 })
  );
  assert.equal(result, "task123");
  assert.equal(body.ratio, "adaptive");
  assert.equal(body.duration, -1);
  assert.match(body.content[0].text, /^Edit the attached reference video as follows: /);
});

test("createVideoTask: extend task keeps the requested duration", async () => {
  const { body } = await withFakeArkResponse("task456", () =>
    createVideoTask({ prompt: "continue it", taskMode: "extend", duration: 12 })
  );
  assert.equal(body.ratio, "adaptive");
  assert.equal(body.duration, 12);
  assert.match(body.content[0].text, /^Extend the attached reference video forward in time: /);
});

test("createVideoTask: generate task defaults generate_audio to false", async () => {
  const { body } = await withFakeArkResponse("task789", () =>
    createVideoTask({ prompt: "a scene" })
  );
  assert.equal(body.generate_audio, false);
});

test("createVideoTask: generate_audio is only true when explicitly requested", async () => {
  const { body } = await withFakeArkResponse("task790", () =>
    createVideoTask({ prompt: "a scene", generateAudio: true })
  );
  assert.equal(body.generate_audio, true);
});

// ── reproducibility seed (Phase 3.1) ────────────────────────────────────────

test("createVideoTask: seed is included when a number is given", async () => {
  const { body } = await withFakeArkResponse("task-seed-1", () =>
    createVideoTask({ prompt: "a scene", seed: 42 })
  );
  assert.equal(body.seed, 42);
});

test("createVideoTask: seed is omitted entirely (not null/undefined) when not given", async () => {
  const { body } = await withFakeArkResponse("task-seed-2", () =>
    createVideoTask({ prompt: "a scene" })
  );
  assert.equal("seed" in body, false);
});

test("createVideoTask: a non-number seed is not sent, same as absent", async () => {
  const { body } = await withFakeArkResponse("task-seed-3", () =>
    createVideoTask({ prompt: "a scene", seed: "42" })
  );
  assert.equal("seed" in body, false);
});

// ── multi-shot chaining / first_frame (Phase 3.3) ───────────────────────────

test("createVideoTask: firstFrame adds a role:\"first_frame\" content item", async () => {
  const { body } = await withFakeArkResponse("task-firstframe-1", () =>
    createVideoTask({
      prompt: "a scene",
      firstFrame: { dataUrl: "data:image/jpeg;base64,AAAA" },
    })
  );
  const item = body.content.find((c) => c.role === "first_frame");
  assert.ok(item, "expected a first_frame content item");
  assert.equal(item.type, "image_url");
  assert.equal(item.image_url.url, "data:image/jpeg;base64,AAAA");
});

test("createVideoTask: no first_frame content item when firstFrame is absent", async () => {
  const { body } = await withFakeArkResponse("task-firstframe-2", () =>
    createVideoTask({ prompt: "a scene" })
  );
  assert.equal(
    body.content.some((c) => c.role === "first_frame"),
    false
  );
});

test("createVideoTask: firstFrame coexists with ordinary reference_image items", async () => {
  const { body } = await withFakeArkResponse("task-firstframe-3", () =>
    createVideoTask({
      prompt: "a scene",
      references: [{ dataUrl: "data:image/png;base64,BBBB", tag: "@img1", index: 1 }],
      firstFrame: { dataUrl: "data:image/jpeg;base64,AAAA" },
    })
  );
  const roles = body.content.filter((c) => c.type === "image_url").map((c) => c.role);
  assert.deepEqual(roles.sort(), ["first_frame", "reference_image"].sort());
});

test("createVideoTask: @imgN/@vidN tags are translated to Seedance's bracket form", async () => {
  const { body } = await withFakeArkResponse("task791", () =>
    createVideoTask({ prompt: "use @img1 and continue @vid2", taskMode: "edit" })
  );
  assert.match(body.content[0].text, /\[image 1\]/);
  assert.match(body.content[0].text, /\[video 2\]/);
});

// ── per-reference role legend wiring (2026-08-17, Phase 1.3/1.4) ───────────
//
// video-directive.test.js pins buildVideoDirective's own behavior once
// handed a refRoles map; these pin that createVideoTask actually BUILDS that
// map correctly from a real prompt + references array — the wiring that
// would ship broken even with a fully passing video-directive.test.js (e.g.
// a tag/index mismatch, or the wrong prompt being scanned).

test("createVideoTask: mixed person+style references wire a scoped role legend into the directive", async () => {
  const prompt =
    "THIS EXACT FACE and identity from @img1. She dances under neon light. " +
    "Match the exact mood and color grade from @img2.";
  const { body } = await withFakeArkResponse("task792", () =>
    createVideoTask({
      prompt,
      references: [
        { tag: "@img1", index: 1, dataUrl: "data:image/png;base64,AAAA" },
        { tag: "@img2", index: 2, dataUrl: "data:image/png;base64,BBBB" },
      ],
    })
  );
  const text = body.content[0].text;
  assert.match(
    text,
    /REFERENCES:\n\[image 1\] = the exact face\/identity of the subject.*\n\[image 2\] = the exact visual style\/grade to match\./
  );
  assert.match(text, /STYLE — FOLLOW THIS TAGGED REFERENCE ONLY/);
  assert.match(text, /\[image 2\] defines the visual style of this shot/);
  assert.match(
    text,
    /IDENTITY LOCK: this tagged reference — \[image 1\] — defines the exact, fixed appearance/
  );
});

test("createVideoTask: untagged references produce the original generic wording (buildRefRoles wiring is a no-op without resolvable tags)", async () => {
  const { body } = await withFakeArkResponse("task793", () =>
    createVideoTask({
      prompt: "she dances under neon light",
      references: [{ tag: "@img1", index: 1, dataUrl: "data:image/png;base64,AAAA" }],
    })
  );
  const text = body.content[0].text;
  assert.doesNotMatch(text, /REFERENCES:\n/);
  assert.match(text, /STYLE — FOLLOW THE REFERENCE \(unless/);
});

test("createVideoTask: missing ARK_API_KEY throws a clear, actionable error before any network call", async () => {
  const originalKey = process.env.ARK_API_KEY;
  delete process.env.ARK_API_KEY;
  try {
    await assert.rejects(
      () => createVideoTask({ prompt: "x" }),
      /ARK_API_KEY is not set/
    );
  } finally {
    if (originalKey !== undefined) process.env.ARK_API_KEY = originalKey;
  }
});

test("createVideoTask: Seedance 2.0 rejects a tenth reference before network", async () => {
  await assert.rejects(
    createVideoTask({
      modelDisplay: "Seedance 2.0",
      prompt: "A shot",
      references: Array.from({ length: 10 }, (_, index) => ({
        tag: `@img${index + 1}`,
        index: index + 1,
        dataUrl: "data:image/jpeg;base64,AA==",
      })),
    }),
    (error) => {
      assert.ok(error instanceof SeedanceError);
      assert.equal(error.code, "too_many_reference_images");
      assert.equal(error.status, 400);
      assert.match(error.message, /at most 9 reference images \(got 10\)/);
      return true;
    }
  );
});
