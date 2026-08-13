import test from "node:test";
import assert from "node:assert/strict";
import {
  hashPassword,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  validatePassword,
  verifyPassword,
} from "./password";

test("password validation enforces inclusive 8-128 character bounds", () => {
  assert.match(validatePassword("a".repeat(MIN_PASSWORD_LENGTH - 1)) ?? "", /at least 8/);
  assert.equal(validatePassword("a".repeat(MIN_PASSWORD_LENGTH)), null);
  assert.equal(validatePassword("a".repeat(MAX_PASSWORD_LENGTH)), null);
  assert.match(
    validatePassword("a".repeat(MAX_PASSWORD_LENGTH + 1)) ?? "",
    /no more than 128/
  );
});

test("hashPassword salts each hash and verifyPassword accepts only the source password", () => {
  const first = hashPassword("correct horse battery staple");
  const second = hashPassword("correct horse battery staple");

  assert.notEqual(first.salt, second.salt);
  assert.notEqual(first.hash, second.hash);
  assert.equal(
    verifyPassword("correct horse battery staple", first.hash, first.salt),
    true
  );
  assert.equal(verifyPassword("wrong password", first.hash, first.salt), false);
});

test("verifyPassword safely rejects malformed stored credentials", () => {
  assert.equal(verifyPassword("password", "not-hex", "salt"), false);
  assert.equal(verifyPassword("password", "", "salt"), false);
});
