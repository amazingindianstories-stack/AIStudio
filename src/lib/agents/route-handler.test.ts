import test from "node:test";
import assert from "node:assert/strict";
import { parseMessages } from "./route-handler";

test("parseMessages accepts a well-formed single-turn array", () => {
  const out = parseMessages([{ role: "user", content: "help me with this shot" }]);
  assert.deepEqual(out, [{ role: "user", content: "help me with this shot" }]);
});

test("parseMessages rejects a non-array", () => {
  assert.equal(parseMessages(undefined), null);
  assert.equal(parseMessages("hi"), null);
  assert.equal(parseMessages({ role: "user", content: "hi" }), null);
});

test("parseMessages rejects an empty array", () => {
  assert.equal(parseMessages([]), null);
});

test("parseMessages rejects an unknown role", () => {
  assert.equal(parseMessages([{ role: "tool", content: "x" }]), null);
});

test("parseMessages rejects blank/whitespace-only content", () => {
  assert.equal(parseMessages([{ role: "user", content: "   " }]), null);
  assert.equal(parseMessages([{ role: "user", content: "" }]), null);
});

test("parseMessages rejects a non-string content field", () => {
  assert.equal(parseMessages([{ role: "user", content: 5 }]), null);
});

test("parseMessages caps message count at 40", () => {
  const many = Array.from({ length: 41 }, () => ({ role: "user", content: "hi" }));
  assert.equal(parseMessages(many), null);
  const ok = Array.from({ length: 40 }, () => ({ role: "user", content: "hi" }));
  assert.equal(parseMessages(ok)?.length, 40);
});

test("parseMessages truncates an overlong message rather than rejecting it", () => {
  const long = "a".repeat(9000);
  const out = parseMessages([{ role: "user", content: long }]);
  assert.equal(out?.[0]?.content.length, 8000);
});
