/**
 * Tests for the pure/black-box-testable parts of providers/seedance.js.
 *
 * These cases cover the provider's pure and black-box-testable behavior,
 * following this codebase's own convention (kling.test.js) of
 * asserting on the assembled request body rather than mocking a driver
 * object: `pickModel`/`tagsToImageRefs` are module-private here (unlike
 * module-private, so their effects are exercised indirectly through
 * createVideoTask's output,
 * the same way kling.test.js exercises buildKlingPayload's callers.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createFinalVideoTask, createVideoTask, isModerationMessage, SeedanceError } from "./seedance";

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
  let capturedSignal;
  process.env.ARK_API_KEY = "test-key";
  globalThis.fetch = async (_url, init) => {
    capturedBody = JSON.parse(init.body);
    capturedSignal = init.signal;
    return {
      ok: true,
      status: 200,
      json: async () => ({ id: taskId }),
      text: async () => JSON.stringify({ id: taskId }),
    };
  };
  try {
    const result = await run();
    return { result, body: capturedBody, signal: capturedSignal };
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.ARK_API_KEY;
    else process.env.ARK_API_KEY = originalKey;
  }
}

test("createVideoTask: Seedance 2.5 forwards 1080p without downgrading", async () => {
  const { body } = await withFakeArkResponse("task1080", () =>
    createVideoTask({ prompt: "A landscape", modelDisplay: "Seedance 2.5", resolution: "1080p", duration: 4 })
  );
  assert.equal(body.resolution, "1080p");
});

test("createFinalVideoTask sends only the draft contract and optional callback", async () => {
  const { result, body } = await withFakeArkResponse("final-task", () =>
    createFinalVideoTask({
      modelDisplay: "Seedance 2.5",
      draftTaskId: "draft-task",
      callbackUrl: "https://example.test/callback",
      prompt: "must not leak",
      duration: 12,
      ratio: "16:9",
      seed: 42,
      generateAudio: true,
      draftMode: true,
    })
  );
  assert.equal(result, "final-task");
  assert.deepEqual(body, {
    model: "dreamina-seedance-2-5-260628",
    content: [{ type: "draft_task", draft_task: { id: "draft-task" } }],
    resolution: "1080p",
    callback_url: "https://example.test/callback",
  });
});

test("createVideoTask: edit task forces adaptive ratio and duration -1", async () => {
  const { result, body } = await withFakeArkResponse("task123", () =>
    createVideoTask({ prompt: "do the edit", modelDisplay: "Seedance 2.5", referenceVideoUrls: ["https://example.com/source.mp4"], taskMode: "edit", ratio: "16:9", duration: 10 })
  );
  assert.equal(result, "task123");
  assert.equal(body.ratio, "adaptive");
  assert.equal(body.duration, -1);
  assert.match(body.content[0].text, /^Edit the attached reference video as follows: /);
});

test("createVideoTask: extend task keeps the requested duration", async () => {
  const { body } = await withFakeArkResponse("task456", () =>
    createVideoTask({ prompt: "continue it", modelDisplay: "Seedance 2.5", referenceVideoUrls: ["https://example.com/source.mp4"], taskMode: "extend", duration: 12 })
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
  assert.equal("draft" in body, false);
  assert.equal(body.bitrate_mode, "high");
});

test("createVideoTask: 2.0 omits Draft but sends bitrate with ratio/duration", async () => {
  const { body } = await withFakeArkResponse("task-render-controls", () =>
    createVideoTask({
      prompt: "A sample Seedance 2.0 shot",
      modelDisplay: "Seedance 2.0",
      ratio: "16:9",
      duration: 10,
      draftMode: true,
      bitrateMode: "standard",
    })
  );
  assert.equal("draft" in body, false);
  assert.equal(body.bitrate_mode, "standard");
  assert.equal(body.ratio, "16:9");
  assert.equal(body.duration, 10);
});

test("createVideoTask: Seedance 2.5 sends explicit Draft true or false", async () => {
  for (const draftMode of [true, false]) {
    const { body } = await withFakeArkResponse(`task-draft-${draftMode}`, () =>
      createVideoTask({ prompt: "a scene", modelDisplay: "Seedance 2.5", draftMode })
    );
    assert.equal(body.draft, draftMode);
    assert.equal(body.bitrate_mode, "high");
  }
});

test("createVideoTask: sends either bitrate value to direct Seedance models", async () => {
  for (const bitrateMode of ["standard", "high"]) {
    const { body } = await withFakeArkResponse(`task-${bitrateMode}`, () =>
      createVideoTask({ prompt: "a scene", modelDisplay: "Seedance 2.5", draftMode: false, bitrateMode })
    );
    assert.equal(body.draft, false);
    assert.equal(body.bitrate_mode, bitrateMode);
  }
});

test("createVideoTask: generate_audio is only true when explicitly requested", async () => {
  const { body } = await withFakeArkResponse("task790", () =>
    createVideoTask({ prompt: "a scene", generateAudio: true })
  );
  assert.equal(body.generate_audio, true);
});

test("createVideoTask: translates and forwards tagged audio references", async () => {
  const { body } = await withFakeArkResponse("task-audio", () =>
    createVideoTask({
      prompt: "Animate @img1 to the beat of @audio1",
      references: [{ tag: "@img1", index: 1, dataUrl: "data:image/png;base64,AAAA" }],
      referenceAudioUrls: ["https://media.example/audio.mp3"],
      generateAudio: true,
    })
  );
  assert.match(body.content[0].text, /\[audio 1\]/);
  assert.deepEqual(body.content.at(-1), {
    type: "audio_url",
    audio_url: { url: "https://media.example/audio.mp3" },
    role: "reference_audio",
  });
});

test("createVideoTask: forwards the queue abort signal to fetch", async () => {
  const controller = new AbortController();
  const { signal } = await withFakeArkResponse("task-signal", () =>
    createVideoTask({ prompt: "a scene", signal: controller.signal })
  );
  assert.equal(signal, controller.signal);
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
    createVideoTask({ prompt: "use @img1 and continue @vid2", modelDisplay: "Seedance 2.5", referenceVideoUrls: ["https://example.com/source.mp4"], taskMode: "edit" })
  );
  assert.match(body.content[0].text, /@Image 1/);
  assert.match(body.content[0].text, /@Video 2/);
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

for (const rawBody of [JSON.stringify({ error: { code: "SensitiveContent", message: "blocked" }, request_id: "body-id" }), "upstream unavailable"]) {
  test(`submission preserves rejection diagnostics: ${rawBody}`, async () => {
    const originalFetch = globalThis.fetch;
    const originalKey = process.env.ARK_API_KEY;
    process.env.ARK_API_KEY = "test-key";
    globalThis.fetch = async () => new Response(rawBody, { status: 400, headers: { "x-tt-logid": "trace-id" } });
    try {
      await assert.rejects(createVideoTask({ prompt: "landscape", modelDisplay: "Seedance 2.5" }), error => {
        assert.equal(error.providerResponse.rawBody, rawBody);
        assert.equal(error.providerResponse.httpStatus, 400);
        assert.equal(error.providerResponse.requestId, "trace-id");
        if (rawBody.includes("SensitiveContent")) assert.equal(error.code, "moderation");
        return true;
      });
    } finally {
      globalThis.fetch = originalFetch;
      if (originalKey === undefined) delete process.env.ARK_API_KEY;
      else process.env.ARK_API_KEY = originalKey;
    }
  });
}

test("createVideoTask: passes asset:// URIs through in image_url content items", async () => {
  const { body } = await withFakeArkResponse("task-asset-test", () =>
    createVideoTask({
      modelDisplay: "Seedance 2.0",
      prompt: "@img1 walks into the neon diner",
      references: [
        {
          tag: "@img1",
          index: 1,
          dataUrl: "asset://asset-20260318035710-kctzf",
        },
      ],
    })
  );

  const imageItems = body.content.filter((c) => c.type === "image_url");
  assert.equal(imageItems.length, 1);
  assert.equal(imageItems[0].image_url.url, "asset://asset-20260318035710-kctzf");
  assert.equal(imageItems[0].role, "reference_image");
});

test("createVideoTask: translates named material slugs and ad-hoc @img tags to [image N]", async () => {
  const { body } = await withFakeArkResponse("task-material-test", () =>
    createVideoTask({
      modelDisplay: "Seedance 2.0",
      prompt: "@sati stands in front of @scene1 holding a glowing orb with @img1 style",
      references: [
        {
          tag: "@sati",
          slug: "sati",
          kind: "character",
          name: "Sati",
          index: 1,
          dataUrl: "data:image/jpeg;base64,SATI_BASE64",
        },
        {
          tag: "@scene1",
          slug: "scene1",
          kind: "location",
          name: "Scene 1",
          index: 2,
          dataUrl: "data:image/jpeg;base64,SCENE_BASE64",
        },
        {
          tag: "@img1",
          index: 3,
          dataUrl: "data:image/jpeg;base64,ADHOC_BASE64",
        },
      ],
    })
  );

  const text = body.content[0].text;
  assert.match(text, /\[image 1\] stands in front of \[image 2\]/);
  assert.match(text, /with \[image 3\] style/);
  assert.match(text, /\[image 1\] = the exact face\/identity/);
  assert.match(text, /\[image 2\] = the exact location\/setting/);
  assert.match(text, /\[image 3\] defines the visual style/);

  const imageItems = body.content.filter((c) => c.type === "image_url");
  assert.equal(imageItems.length, 3);
  assert.equal(imageItems[0].image_url.url, "data:image/jpeg;base64,SATI_BASE64");
  assert.equal(imageItems[1].image_url.url, "data:image/jpeg;base64,SCENE_BASE64");
  assert.equal(imageItems[2].image_url.url, "data:image/jpeg;base64,ADHOC_BASE64");
});

test("createVideoTask: firstFrame sets role first_frame and forces ratio adaptive", async () => {
  const { body } = await withFakeArkResponse("task-first-frame", () =>
    createVideoTask({
      prompt: "A drone flying over mountains",
      modelDisplay: "Seedance 2.5",
      firstFrame: { dataUrl: "data:image/jpeg;base64,FIRST_FRAME_DATA" },
      ratio: "16:9",
      duration: 8,
    })
  );
  assert.equal(body.ratio, "adaptive");
  assert.equal(body.duration, 8);
  const firstFrameItem = body.content.find((c) => c.role === "first_frame");
  assert.ok(firstFrameItem, "first_frame item must exist");
  assert.equal(firstFrameItem.type, "image_url");
  assert.equal(firstFrameItem.image_url.url, "data:image/jpeg;base64,FIRST_FRAME_DATA");
});

test("createVideoTask: firstFrame and lastFrame sets both roles with adaptive ratio", async () => {
  const { body } = await withFakeArkResponse("task-first-last", () =>
    createVideoTask({
      prompt: "A camera morphing between two positions",
      modelDisplay: "Seedance 2.5",
      firstFrame: { dataUrl: "data:image/jpeg;base64,FIRST_DATA" },
      lastFrame: { dataUrl: "data:image/jpeg;base64,LAST_DATA" },
      ratio: "16:9",
      duration: 5,
    })
  );
  assert.equal(body.ratio, "adaptive");
  assert.equal(body.duration, 5);
  const first = body.content.find((c) => c.role === "first_frame");
  const last = body.content.find((c) => c.role === "last_frame");
  assert.ok(first, "first_frame role must exist");
  assert.ok(last, "last_frame role must exist");
  assert.equal(first.image_url.url, "data:image/jpeg;base64,FIRST_DATA");
  assert.equal(last.image_url.url, "data:image/jpeg;base64,LAST_DATA");
});

test("createVideoTask: lastFrame without firstFrame throws missing_first_frame", async () => {
  await assert.rejects(
    () =>
      createVideoTask({
        prompt: "Invalid interpolation",
        modelDisplay: "Seedance 2.5",
        lastFrame: { dataUrl: "data:image/jpeg;base64,LAST_DATA" },
      }),
    (err) => {
      assert.ok(err instanceof SeedanceError);
      assert.equal(err.code, "missing_first_frame");
      assert.equal(err.status, 400);
      return true;
    }
  );
});


const image = (n) => ({ tag: `@img${n}`, index: n, dataUrl: `asset://character-${n}` });
const video = "https://example.com/motion.mp4";
const audio = "https://example.com/music.mp3";
for (const [name, options, hint, ratio, duration, roles] of [
  ["text-only", {}, undefined, "16:9", 4, []],
  ["character", { references: [image(1)] }, "reference", "16:9", 4, ["reference_image"]],
  ["motion", { referenceVideoUrls: [video] }, "reference", "16:9", 4, ["reference_video"]],
  ["motion and characters", { referenceVideoUrls: [video], references: [image(1), image(2)] }, "reference", "16:9", 4, ["reference_image", "reference_image", "reference_video"]],
  ["audio-only", { referenceAudioUrls: [audio] }, "reference", "16:9", 4, ["reference_audio"]],
  ["edit", { taskMode: "edit", referenceVideoUrls: [video] }, "edit", "adaptive", -1, ["reference_video"]],
  ["edit and character", { taskMode: "edit", referenceVideoUrls: [video], references: [image(1)] }, "edit", "adaptive", -1, ["reference_image", "reference_video"]],
  ["extend", { taskMode: "extend", referenceVideoUrls: [video] }, "extend", "adaptive", 4, ["reference_video"]],
  ["first frame", { firstFrame: image(1), references: [image(2)] }, undefined, "adaptive", 4, ["reference_image", "first_frame"]],
  ["first and last frame", { firstFrame: image(1), lastFrame: image(2) }, undefined, "adaptive", 4, ["first_frame", "last_frame"]],
  ["2.0 references", { modelDisplay: "Seedance 2.0", references: [image(1)], referenceVideoUrls: [video] }, undefined, "16:9", 4, ["reference_image", "reference_video"]],
]) {
  test(`Seedance request contract: ${name}`, async () => {
    const input = { modelDisplay: "Seedance 2.5", taskMode: "generate", prompt: "New scene", ratio: "16:9", duration: 4, ...options };
    const { body } = await withFakeArkResponse("contract-task", () => createVideoTask(input));
    assert.equal(body.omni_reference_task_type, hint);
    if (hint === undefined) assert.equal(Object.hasOwn(body, "omni_reference_task_type"), false);
    assert.equal(body.model, input.modelDisplay === "Seedance 2.5" ? "dreamina-seedance-2-5-260628" : "dreamina-seedance-2-0-260128");
    assert.equal(body.ratio, ratio); assert.equal(body.duration, duration);
    assert.deepEqual(body.content.slice(1).map((c) => c.role), roles);
  });
}

test("Seedance 2.5 uses official asset tags with named-image references", async () => {
  const { body } = await withFakeArkResponse("tags", () => createVideoTask({
    modelDisplay: "Seedance 2.5", prompt: "@hero follows motion @vid1 and music @audio1", references: [{ ...image(1), tag: "@hero" }],
    referenceVideoUrls: [video], referenceAudioUrls: [audio],
  }));
  assert.match(body.content[0].text, /@Image 1 follows motion @Video 1 and music @Audio 1/);
  assert.doesNotMatch(body.content[0].text, /\[(?:image|video|audio) \d+\]/);
});

test("Seedance rejects Edit/Extend without a source and frame-mode conflicts before fetch", async () => {
  for (const taskMode of ["edit", "extend"]) {
    await assert.rejects(createVideoTask({ modelDisplay: "Seedance 2.5", taskMode, prompt: "test" }), { code: "missing_source_video" });
    await assert.rejects(createVideoTask({ modelDisplay: "Seedance 2.5", taskMode, prompt: "test", referenceVideoUrls: [video], firstFrame: image(1) }), { code: "invalid_frame_task" });
  }
});
