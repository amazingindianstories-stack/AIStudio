import test from "node:test";
import assert from "node:assert/strict";
import { remapSubmittedMediaTags } from "./seedance-reference-tags.js";

test("selected video/audio subsets map tags to the actual submitted order", () => {
  assert.equal(remapSubmittedMediaTags("Motion @vid4 then @vid2, sound @audio3 and @audio1", [1, 2, 3, 4], [1, 2, 3]),
    "Motion @vid2 then @vid1, sound @audio2 and @audio1");
});
test("unmentioned assets and image tags do not rewrite artistic prompt text", () => {
  const prompt = "@hero with @img3; original motion and camera";
  assert.equal(remapSubmittedMediaTags(prompt, [1, 2], [1]), prompt);
});
