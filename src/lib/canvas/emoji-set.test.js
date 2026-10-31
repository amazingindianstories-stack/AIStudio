import test from "node:test";
import assert from "node:assert/strict";
import { searchEmoji, withTone, rememberRecent, readRecents, readTone, saveTone, EMOJI } from "./emoji-set.js";

const memory = () => {
  const map = new Map();
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, v) };
};

test("search matches every word and an empty search lists everything", () => {
  assert.equal(searchEmoji("").length, EMOJI.length);
  assert.ok(searchEmoji("thumbs up").some((e) => e.base === "👍"));
  assert.equal(searchEmoji("thumbs rocket").length, 0);
});

test("skin tone applies only to emoji that take one", () => {
  assert.equal(withTone("👍", "dark"), "👍\u{1F3FF}");
  assert.equal(withTone("🔥", "dark"), "🔥");
  assert.equal(withTone("🧑‍💻", "light"), "🧑\u{1F3FB}‍💻");
  assert.equal(withTone("👍", "default"), "👍");
  assert.equal(searchEmoji("clap", "medium")[0].emoji, "👏\u{1F3FD}");
});

test("recents keep the newest first without duplicates and cap at sixteen", () => {
  const store = memory();
  for (const e of ["a", "b", "a"]) rememberRecent(e, store);
  assert.deepEqual(readRecents(store), ["a", "b"]);
  for (let i = 0; i < 30; i += 1) rememberRecent(`e${i}`, store);
  assert.equal(readRecents(store).length, 16);
});

test("a broken or blocked store never throws", () => {
  const blocked = { getItem() { throw new Error("no"); }, setItem() { throw new Error("no"); } };
  assert.deepEqual(readRecents(blocked), []);
  assert.deepEqual(rememberRecent("x", blocked), ["x"]);
  assert.equal(readTone(blocked), "default");
  saveTone("dark", blocked);
  const store = memory();
  saveTone("dark", store);
  assert.equal(readTone(store), "dark");
});
