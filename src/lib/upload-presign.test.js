import test from "node:test";
import assert from "node:assert/strict";
import { createUploadPresign } from "./upload-presign.js";

const cases = [
  ["image-reference", "image/png", "uploads/image-reference"],
  ["audio-reference", "audio/mpeg", "uploads/audio-reference"],
  ["depth-input", "video/mp4", "uploads/depth-input"],
];

for (const [purpose, contentType, prefix] of cases) {
  test(`presigns authenticated ${purpose} uploads with the exact content type`, async () => {
    const calls = [];
    const result = await createUploadPresign(
      { userId: "user-7", purpose, contentType },
      {
        createId: () => "upload-id",
        signUploadUrl: async (...args) => {
          calls.push(args);
          return "https://storage.example/signed";
        },
      }
    );

    assert.deepEqual(result, {
      status: 200,
      body: {
        key: `${prefix}/user-7-upload-id`,
        uploadUrl: "https://storage.example/signed",
      },
    });
    assert.deepEqual(calls, [[`${prefix}/user-7-upload-id`, contentType]]);
  });
}

test("rejects unauthenticated uploads before signing", async () => {
  let signed = false;
  const result = await createUploadPresign(
    { purpose: "image-reference", contentType: "image/png" },
    { signUploadUrl: async () => { signed = true; } }
  );
  assert.equal(result.status, 401);
  assert.equal(signed, false);
});

test("rejects unknown purposes and mismatched MIME types", async () => {
  const dependencies = { signUploadUrl: async () => assert.fail("must not sign") };
  assert.equal((await createUploadPresign({ userId: "u", purpose: "avatar", contentType: "image/png" }, dependencies)).status, 400);
  assert.equal((await createUploadPresign({ userId: "u", purpose: "image-reference", contentType: "video/mp4" }, dependencies)).status, 400);
  assert.equal((await createUploadPresign({ userId: "u", purpose: "depth-input", contentType: "" }, dependencies)).status, 400);
});

test("normalizes the image/jpg browser alias before signing", async () => {
  const calls = [];
  const result = await createUploadPresign(
    { userId: "u", purpose: "image-reference", contentType: " IMAGE/JPG " },
    { createId: () => "id", signUploadUrl: async (...args) => { calls.push(args); return "signed"; } }
  );
  assert.equal(result.status, 200);
  assert.deepEqual(calls, [["uploads/image-reference/u-id", "image/jpeg"]]);
});

test("returns a sanitized signing failure without leaking credentials", async (t) => {
  const logs = [];
  t.mock.method(console, "error", (...args) => logs.push(args));
  const result = await createUploadPresign(
    { userId: "u", purpose: "image-reference", contentType: "image/png" },
    { signUploadUrl: async () => { throw new Error("private-key=secret-value"); } }
  );
  assert.deepEqual(result, { status: 500, body: { error: "Failed to create an upload URL." } });
  assert.doesNotMatch(JSON.stringify(result.body), /secret-value|private-key/);
  assert.doesNotMatch(JSON.stringify(logs), /secret-value|private-key/);
});
