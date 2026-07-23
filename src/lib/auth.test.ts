import assert from "node:assert/strict";
import test from "node:test";
import { signSession, verifySessionToken } from "./auth";

test("stateless session verification accepts an untampered signed cookie", () => {
  const token = signSession("4fc7a769-ece3-456e-8d36-5ecb90bbcebf", 3);

  assert.deepEqual(verifySessionToken(token), {
    userId: "4fc7a769-ece3-456e-8d36-5ecb90bbcebf",
    authVersion: 3,
  });
});

test("stateless session verification rejects tampered and malformed cookies", () => {
  const token = signSession("4fc7a769-ece3-456e-8d36-5ecb90bbcebf", 3);
  const [payload, signature] = token.split(".");

  assert.equal(verifySessionToken(`${payload}.${signature}x`), null);
  assert.equal(verifySessionToken("not-a-session"), null);
  assert.equal(verifySessionToken(""), null);
});
