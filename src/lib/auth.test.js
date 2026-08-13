import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";
import {
  signSession,
  verifySessionToken,
  shouldRenewSession,
  sessionCookieOptions,
  SESSION_MAX_AGE_SECONDS,
  canManage,
} from "./auth";

const DAY_MS = 1000 * 60 * 60 * 24;
const SESSION_TTL_MS = 1000 * SESSION_MAX_AGE_SECONDS;

test("stateless session verification accepts an untampered signed cookie", () => {
  const before = Date.now();
  const token = signSession("4fc7a769-ece3-456e-8d36-5ecb90bbcebf", 3);
  const result = verifySessionToken(token);

  assert.equal(result?.userId, "4fc7a769-ece3-456e-8d36-5ecb90bbcebf");
  assert.equal(result?.authVersion, 3);
  // exp is set from Date.now() + the full 30-day TTL at signing time.
  assert.ok(result && result.exp >= before + SESSION_TTL_MS);
  assert.ok(result && result.exp <= Date.now() + SESSION_TTL_MS + 1000);
});

test("stateless session verification rejects tampered and malformed cookies", () => {
  const token = signSession("4fc7a769-ece3-456e-8d36-5ecb90bbcebf", 3);
  const [payload, signature] = token.split(".");

  assert.equal(verifySessionToken(`${payload}.${signature}x`), null);
  assert.equal(verifySessionToken("not-a-session"), null);
  assert.equal(verifySessionToken(""), null);
});

test("stateless session verification rejects an already-expired token", () => {
  // signSession always signs a fresh 30-day token, so to test expiry this
  // hand-builds one the same way signSession does but with exp in the past.
  const payload = Buffer.from(
    JSON.stringify({ uid: "u1", ver: 0, exp: Date.now() - 1000 })
  ).toString("base64url");
  const sig = createHmac("sha256", process.env.AUTH_SECRET || "dev-insecure-secret-change-me")
    .update(payload)
    .digest("base64url");
  assert.equal(verifySessionToken(`${payload}.${sig}`), null);
});

test("shouldRenewSession: a freshly-signed 30-day session is not renewed", () => {
  const now = Date.now();
  const exp = now + SESSION_TTL_MS; // just signed
  assert.equal(shouldRenewSession(exp, now), false);
});

test("shouldRenewSession: a session more than a day old is renewed", () => {
  const now = Date.now();
  const exp = now + SESSION_TTL_MS - (DAY_MS + 1000); // signed just over a day ago
  assert.equal(shouldRenewSession(exp, now), true);
});

test("shouldRenewSession: renewal is throttled, not per-request — just under a day old is not renewed", () => {
  const now = Date.now();
  const exp = now + SESSION_TTL_MS - (DAY_MS - 1000); // signed just under a day ago
  assert.equal(shouldRenewSession(exp, now), false);
});

test("shouldRenewSession: an expired-but-not-yet-rejected exp is treated as renewable", () => {
  // Belt-and-suspenders: verifySessionToken already rejects exp < now outright,
  // but the pure decision function itself shouldn't need that invariant to
  // behave sanely if ever called with a stale value.
  const now = Date.now();
  assert.equal(shouldRenewSession(now - 1, now), true);
});

test("sessionCookieOptions matches the full 30-day retention window and is httpOnly/lax/site-wide", () => {
  const opts = sessionCookieOptions();
  assert.equal(opts.maxAge, SESSION_MAX_AGE_SECONDS);
  assert.equal(opts.httpOnly, true);
  assert.equal(opts.sameSite, "lax");
  assert.equal(opts.path, "/");
});

test("canManage: the owner may manage their own item", () => {
  const user = { id: "u1", role: "user" };
  assert.equal(canManage(user, "u1"), true);
});

test("canManage: a non-owning regular user may not manage someone else's item", () => {
  const user = { id: "u1", role: "user" };
  assert.equal(canManage(user, "u2"), false);
});

test("canManage: an admin may manage anyone's item, owner or not", () => {
  const admin = { id: "u1", role: "admin" };
  assert.equal(canManage(admin, "u2"), true);
  assert.equal(canManage(admin, null), true);
});

test("canManage: an ownerless item (legacy row, no recorded creator) is admin-only, not open", () => {
  const user = { id: "u1", role: "user" };
  assert.equal(canManage(user, null), false);
  assert.equal(canManage(user, undefined), false);
});

test("canManage: no session means no access", () => {
  assert.equal(canManage(null, "u1"), false);
});
