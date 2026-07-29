import test from "node:test";
import assert from "node:assert/strict";
import { signMediaGrant, verifyMediaGrant } from "./media-grant";

/**
 * This route serves stored objects WITHOUT a session, so the token is the only
 * thing standing between an external provider and the bucket. Everything here
 * is about that boundary.
 */

test("a fresh grant round-trips to its key", () => {
  const t = signMediaGrant("generations/abc.mp4");
  assert.equal(verifyMediaGrant(t), "generations/abc.mp4");
});

test("keys with awkward characters survive the encoding", () => {
  const key = "generations/a b+c/d=e.mp4";
  assert.equal(verifyMediaGrant(signMediaGrant(key)), key);
});

test("a tampered key is rejected", () => {
  // The attack this exists to stop: swap the object, keep the signature.
  const t = signMediaGrant("generations/mine.mp4");
  const [, exp, sig] = t.split(".");
  const forged = `${Buffer.from("settings/secrets.json").toString("base64url")}.${exp}.${sig}`;
  assert.equal(verifyMediaGrant(forged), null);
});

test("a tampered expiry is rejected", () => {
  const t = signMediaGrant("generations/abc.mp4", 1);
  const [key, , sig] = t.split(".");
  const forged = `${key}.${Date.now() + 999_000}.${sig}`;
  assert.equal(verifyMediaGrant(forged), null);
});

test("an expired grant is rejected", () => {
  const t = signMediaGrant("generations/abc.mp4", -1);
  assert.equal(verifyMediaGrant(t), null);
});

test("protected prefixes cannot be granted at all", () => {
  // These share the bucket with user media and hold secrets / DB dumps.
  assert.throws(() => signMediaGrant("settings/token.json"));
  assert.throws(() => signMediaGrant("migrations/dump.sql"));
  // case-insensitive: a capitalised prefix must not slip past
  assert.throws(() => signMediaGrant("Settings/Token.json"));
});

test("malformed tokens are rejected rather than throwing", () => {
  for (const bad of [null, undefined, "", "a", "a.b", "a.b.c.d", "...", "x.y.z"]) {
    assert.equal(verifyMediaGrant(bad as string), null, JSON.stringify(bad));
  }
});

test("a signature from a different secret does not verify", () => {
  const t = signMediaGrant("generations/abc.mp4");
  const original = process.env.AUTH_SECRET;
  process.env.AUTH_SECRET = "a-completely-different-secret";
  try {
    // Rotating AUTH_SECRET must invalidate every outstanding grant.
    assert.equal(verifyMediaGrant(t), null);
  } finally {
    if (original === undefined) delete process.env.AUTH_SECRET;
    else process.env.AUTH_SECRET = original;
  }
});
