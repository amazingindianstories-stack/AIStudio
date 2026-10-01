import test from "node:test";
import assert from "node:assert/strict";
import {
  isImgTag,
  isAudioTag,
  parseAudioMentionIndices,
  resolveAudioReferences,
  isVidTag,
  parseAssetSlugs,
  parseMentionIndices,
  parseVideoMentionIndices,
  renumberImgMentions,
  resolveReferences,
  resolveVideoReferences,
  resolveAllReferences,
  normalizePromptMentions,
  syncMentionTagCorrection,
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

test("@audioN is an audio tag, not an asset slug", () => {
  assert.equal(isAudioTag("audio1"), true);
  assert.equal(isAudioTag("AUDIO12"), true);
  assert.equal(isAudioTag("audio"), false);
  assert.equal(isAudioTag("img1"), false);
  assert.deepEqual(parseAssetSlugs("use @audio1 with @priya"), ["priya"]);
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

test("audio tags resolve separately from images, clips and named assets", () => {
  const prompt = "@AUDIO2 @audio2 @img1 @vid1 @priya";
  assert.equal(isAudioTag("AUDIO2"), true);
  assert.equal(isAudioTag("audio"), false);
  assert.deepEqual(parseAssetSlugs(prompt), ["priya"]);
  assert.deepEqual(parseAudioMentionIndices(prompt), [2]);
  assert.deepEqual(resolveAudioReferences(prompt, ["a.mp3", "b.wav"]), ["b.wav"]);
});

test("renumberImgMentions preserves named material tags completely untouched", () => {
  const prompt = "@sati in @scene-1 holding @img1 and @img2 next to @mysong";
  const renumbered = renumberImgMentions(prompt, [1, 0]);
  assert.equal(
    renumbered,
    "@sati in @scene-1 holding @img2 and @img1 next to @mysong"
  );
});

test("resolveAllReferences resolves named materials and ad-hoc uploads together", () => {
  const assets = [
    { slug: "sati", name: "Sati", kind: "character", images: ["/sati.png"] },
    { slug: "scene-1", name: "Scene 1", kind: "location", images: ["/scene1.png"] },
  ];
  const uploads = ["data:image/jpeg;base64,upload1", "data:image/jpeg;base64,upload2"];
  const prompt = "cinematic shot of @sati in @scene-1 with @img2";

  const resolved = resolveAllReferences(prompt, assets, uploads);
  assert.equal(resolved.materials.length, 2);
  assert.equal(resolved.materials[0].slug, "sati");
  assert.equal(resolved.materials[0].image, "/sati.png");
  assert.equal(resolved.materials[1].slug, "scene-1");
  assert.equal(resolved.materials[1].image, "/scene1.png");

  assert.equal(resolved.images.length, 1);
  assert.equal(resolved.images[0].tag, "@img2");
  assert.equal(resolved.images[0].dataUrl, "data:image/jpeg;base64,upload2");
});

test("normalizePromptMentions standardizes informal tags across modalities", () => {
  const input = "make @image1 green and @image 2 shiny, @img_3 blue, @video 1 camera and @audio 2 sound";
  const expected = "make @img1 green and @img2 shiny, @img3 blue, @vid1 camera and @audio2 sound";
  assert.equal(normalizePromptMentions(input), expected);
});

test("parseMentionIndices parses non-canonical @image1 and @image 1 tags", () => {
  assert.deepEqual(parseMentionIndices("use @image 1 and @image2 with @img_3"), [1, 2, 3]);
  assert.deepEqual(parseMentionIndices("use @image-10 and @IMAGE 2"), [2, 10]);
});

test("syncMentionTagCorrection: correcting first occurrence updates all matching occurrences", () => {
  const prev = "make @image 1 green and then make @image 1 shiny";
  const next = "make @img1 green and then make @image 1 shiny";
  const result = syncMentionTagCorrection(prev, next, 10);

  assert.equal(result.changed, true);
  assert.equal(result.text, "make @img1 green and then make @img1 shiny");
  assert.equal(result.caret, 10);
});

test("syncMentionTagCorrection: correcting second occurrence adjusts caret backwards", () => {
  const prev = "make @image 1 green and then make @image 1 shiny";
  const next = "make @image 1 green and then make @img1 shiny";
  // "@image 1" (8 chars) -> "@img1" (5 chars). Delta is -3 for the earlier match.
  // Original caret was at 39 (end of second @img1 in "make @image 1 green and then make @img1")
  const result = syncMentionTagCorrection(prev, next, 39);

  assert.equal(result.changed, true);
  assert.equal(result.text, "make @img1 green and then make @img1 shiny");
  assert.equal(result.caret, 36);
});

test("syncMentionTagCorrection: updates multiple occurrences (3+) cleanly", () => {
  const prev = "shot of @image 1, close-up of @image 1, and wide of @image 1";
  const next = "shot of @img1, close-up of @image 1, and wide of @image 1";
  const result = syncMentionTagCorrection(prev, next, 13);

  assert.equal(result.changed, true);
  assert.equal(result.text, "shot of @img1, close-up of @img1, and wide of @img1");
  assert.equal(result.caret, 13);
});

test("syncMentionTagCorrection: isolates different indices without cross-contamination", () => {
  const prev = "blend @image 1 with @image 2 and then more @image 1";
  const next = "blend @img1 with @image 2 and then more @image 1";
  const result = syncMentionTagCorrection(prev, next, 11);

  assert.equal(result.changed, true);
  assert.equal(result.text, "blend @img1 with @image 2 and then more @img1");
  assert.equal(result.caret, 11);
});

test("syncMentionTagCorrection: supports re-targeting reference index across prompt", () => {
  const prev = "style @image 1 like @image 1";
  const next = "style @img2 like @image 1";
  const result = syncMentionTagCorrection(prev, next, 10);

  assert.equal(result.changed, true);
  assert.equal(result.text, "style @img2 like @img2");
});

test("syncMentionTagCorrection: handles video and audio tag corrections", () => {
  const vidPrev = "follow @video 1 and cut to @video 1";
  const vidNext = "follow @vid1 and cut to @video 1";
  const vidResult = syncMentionTagCorrection(vidPrev, vidNext, 12);
  assert.equal(vidResult.changed, true);
  assert.equal(vidResult.text, "follow @vid1 and cut to @vid1");

  const audioPrev = "sync @audio 1 with beat in @audio 1";
  const audioNext = "sync @audio1 with beat in @audio 1";
  const audioResult = syncMentionTagCorrection(audioPrev, audioNext, 12);
  assert.equal(audioResult.changed, true);
  assert.equal(audioResult.text, "sync @audio1 with beat in @audio1");
});

test("syncMentionTagCorrection: does not mutate normal typing or already canonical prompts", () => {
  const prev = "make @img1 green";
  const next = "make @img1 green and bright";
  const result = syncMentionTagCorrection(prev, next, next.length);
  assert.equal(result.changed, false);
  assert.equal(result.text, next);
  assert.equal(result.caret, next.length);
});
