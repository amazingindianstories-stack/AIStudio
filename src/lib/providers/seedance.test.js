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
import { createVideoTask, isModerationMessage } from "./seedance";

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

test("createVideoTask: @imgN/@vidN tags are translated to Seedance's bracket form", async () => {
  const { body } = await withFakeArkResponse("task791", () =>
    createVideoTask({ prompt: "use @img1 and continue @vid2", taskMode: "edit" })
  );
  assert.match(body.content[0].text, /\[image 1\]/);
  assert.match(body.content[0].text, /\[video 2\]/);
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
