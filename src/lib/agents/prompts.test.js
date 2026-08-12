import test from "node:test";
import assert from "node:assert/strict";
import { systemPromptFor } from "./prompts";

test("each role gets a distinct, non-empty system prompt", () => {
  const image = systemPromptFor("image");
  const video = systemPromptFor("video");
  const story = systemPromptFor("story");
  assert.ok(image.length > 0);
  assert.ok(video.length > 0);
  assert.ok(story.length > 0);
  assert.notEqual(image, video);
  assert.notEqual(video, story);
  assert.notEqual(image, story);
});

test("image/video prompts are grounded in this app's @tag reference system", () => {
  assert.match(systemPromptFor("image"), /@img1/);
  assert.match(systemPromptFor("video"), /@img1/);
});

test("video prompt is grounded in the actual video model roster", () => {
  assert.match(systemPromptFor("video"), /Seedance/);
});

test("story prompt names the Canvas Board rather than a script editor", () => {
  assert.match(systemPromptFor("story"), /Canvas Board/);
});
