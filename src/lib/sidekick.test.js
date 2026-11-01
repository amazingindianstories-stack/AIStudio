import assert from "node:assert/strict";
import test from "node:test";
import { expandMessage, parseSlash, slashMatches } from "./sidekick.js";

const skills = [{ name: "summarize", description: "Summarize", prompt: "Summarize the selection." }, { name: "ideas", description: "Ideas", prompt: "Give ideas." }];

test("a slash command expands to the skill's instruction plus what follows", () => {
  assert.equal(expandMessage("/summarize", skills), "Summarize the selection.");
  assert.equal(expandMessage("/summarize for kids", skills), "Summarize the selection.\n\nfor kids");
  assert.equal(expandMessage("  plain words ", skills), "plain words");
  assert.equal(expandMessage("/unknown x", skills), "/unknown x");
});

test("slash parsing needs a known skill", () => {
  assert.equal(parseSlash("/nope", skills), null);
  assert.equal(parseSlash("/IDEAS go", skills).rest, "go");
});

test("the slash menu filters by prefix and closes after a space", () => {
  assert.deepEqual(slashMatches("/", skills).map((s) => s.name), ["summarize", "ideas"]);
  assert.deepEqual(slashMatches("/su", skills).map((s) => s.name), ["summarize"]);
  assert.deepEqual(slashMatches("/summarize now", skills), []);
  assert.deepEqual(slashMatches("hello", skills), []);
});
