import { test } from "vitest";
import assert from "node:assert/strict";
import {
  isImgTag,
  isVidTag,
  parseAssetSlugs,
  parseMentionIndices,
  parseVideoMentionIndices,
  renumberImgMentions,
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

/**
 * Drag-reorder of the composer's reference thumbnails calls this to keep
 * already-typed @imgN tags pointing at the same image (see the doc comment
 * on renumberImgMentions — @imgN is a live array index, not a stored id).
 */

test("renumberImgMentions swaps a pair of tags without clobbering", () => {
  // mapping[0]=1, mapping[1]=0: images at index 0 and 1 traded places.
  assert.equal(
    renumberImgMentions("put @img1 next to @img2", [1, 0]),
    "put @img2 next to @img1"
  );
});

test("renumberImgMentions handles a move-to-end shift", () => {
  // First image dragged to the last slot; the other two shift down by one.
  assert.equal(
    renumberImgMentions("@img1 @img2 @img3", [2, 0, 1]),
    "@img3 @img1 @img2"
  );
});

test("renumberImgMentions leaves out-of-range tags untouched", () => {
  // Only 2 images in the mapping; @img5 doesn't correspond to any of them.
  assert.equal(
    renumberImgMentions("@img1 and @img5", [1, 0]),
    "@img2 and @img5"
  );
});

test("renumberImgMentions is case-insensitive on input, normalizes output", () => {
  assert.equal(renumberImgMentions("@IMG2 stays put", [1, 0]), "@img1 stays put");
});

test("renumberImgMentions renumbers every occurrence of a repeated tag", () => {
  assert.equal(
    renumberImgMentions("@img1 matches @img1 again", [1, 0]),
    "@img2 matches @img2 again"
  );
});
