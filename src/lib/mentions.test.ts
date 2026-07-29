import test from "node:test";
import assert from "node:assert/strict";
import {
  isImgTag,
  isVidTag,
  parseAssetSlugs,
  parseMentionIndices,
  parseVideoMentionIndices,
  resolveReferences,
  resolveVideoReferences,
} from "./mentions";

/**
 * @vidN shipped as a provider-side token with nothing on the client producing
 * or recognising it. The parser treated it as a saved-asset slug named "vid1",
 * found no such asset, and left it in the prompt as ordinary text — so typing
 * it did nothing and no clip was ever attached. These pin the namespace split.
 */

test("@vidN is a clip tag, not an asset slug", () => {
  assert.equal(isVidTag("vid1"), true);
  assert.equal(isVidTag("vid12"), true);
  assert.equal(isImgTag("vid1"), false);
  assert.equal(isVidTag("img1"), false);
  assert.equal(isVidTag("video"), false, "bare word must stay an asset slug");
  assert.equal(isVidTag("priya"), false);
});

test("parseAssetSlugs no longer swallows @vidN", () => {
  // The actual bug: this used to return ["vid1"], sending the prompt off to
  // look up an asset that does not exist.
  assert.deepEqual(parseAssetSlugs("replace the guy in @vid1 with @img1"), []);
  assert.deepEqual(parseAssetSlugs("@priya in @vid1 doing @img2"), ["priya"]);
});

test("clip and image tag namespaces do not collide", () => {
  const prompt = "put @img1 into the action from @vid2";
  assert.deepEqual(parseMentionIndices(prompt), [1]);
  assert.deepEqual(parseVideoMentionIndices(prompt), [2]);
});

test("video indices parse in ascending order, deduped, case-insensitive", () => {
  assert.deepEqual(parseVideoMentionIndices("@vid3 @VID1 @vid3 @Vid2"), [1, 2, 3]);
});

test("an explicit @vidN tag selects only that clip", () => {
  const clips = ["/a.mp4", "/b.mp4", "/c.mp4"];
  assert.deepEqual(resolveVideoReferences("use @vid2 only", clips), ["/b.mp4"]);
  assert.deepEqual(resolveVideoReferences("@vid3 then @vid1", clips), [
    "/a.mp4",
    "/c.mp4",
  ]);
});

test("no tags means send every attached clip", () => {
  const clips = ["/a.mp4", "/b.mp4"];
  assert.deepEqual(resolveVideoReferences("continue this shot", clips), clips);
});

test("out-of-range clip tags are ignored rather than sending nothing", () => {
  const clips = ["/a.mp4"];
  // @vid9 with one clip: falls back to all, matching the image behaviour.
  assert.deepEqual(resolveVideoReferences("use @vid9", clips), ["/a.mp4"]);
});

test("no clips attached means nothing to send", () => {
  assert.deepEqual(resolveVideoReferences("use @vid1", []), []);
});

test("image resolution is unchanged by the video tag namespace", () => {
  const uploads = ["data:image/jpeg;base64,A", "data:image/jpeg;base64,B"];
  assert.deepEqual(
    resolveReferences("put @img2 into @vid1", uploads).map((r) => r.tag),
    ["@img2"]
  );
});

test("a prompt mixing all three tag kinds resolves each independently", () => {
  const prompt = "@priya wearing @img1, moving like @vid1";
  assert.deepEqual(parseAssetSlugs(prompt), ["priya"]);
  assert.deepEqual(parseMentionIndices(prompt), [1]);
  assert.deepEqual(parseVideoMentionIndices(prompt), [1]);
});
