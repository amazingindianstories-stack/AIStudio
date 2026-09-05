import { test } from "vitest";
import assert from "node:assert/strict";
import { apiFetch, parseApiResponse } from "./api.js";

test("apiFetch always includes cross-origin credentials", async () => {
  const original = globalThis.fetch;
  let received;
  globalThis.fetch = async (_url, options) => {
    received = options;
    return Response.json({ ok: true });
  };
  try {
    await apiFetch("/api/settings", { credentials: "omit", cache: "no-store" });
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(received.credentials, "include");
  assert.equal(received.cache, "no-store");
});

test("parseApiResponse accepts canonical and legacy success envelopes", async () => {
  assert.deepEqual(await parseApiResponse(Response.json({ ok: true, data: { user: null } })), {
    ok: true, data: { user: null }, error: null,
  });
  assert.deepEqual(await parseApiResponse(Response.json({ user: { id: "legacy" } })), {
    ok: true, data: { user: { id: "legacy" } }, error: null,
  });
});

test("parseApiResponse normalizes canonical, legacy, and malformed failures", async () => {
  assert.deepEqual(
    await parseApiResponse(Response.json({ ok: false, error: { code: "UNAUTHENTICATED", message: "Sign in." } }, { status: 401 })),
    { ok: false, data: null, error: { code: "UNAUTHENTICATED", message: "Sign in." } },
  );
  assert.deepEqual(
    await parseApiResponse(Response.json({ error: "Name is required." }, { status: 400 })),
    { ok: false, data: null, error: { code: "REQUEST_FAILED", message: "Name is required." } },
  );
  assert.equal((await parseApiResponse(new Response("gateway", { status: 502 }))).error.code, "INVALID_RESPONSE");
});
