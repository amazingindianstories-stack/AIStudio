import test from "node:test";
import assert from "node:assert/strict";
import { errorResponse, successResponse } from "./api-response.js";
import { parseApiResponse } from "./api.js";

test("successResponse creates the canonical success envelope", async () => {
  const response = successResponse({ user: { id: "user-1" } });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    data: { user: { id: "user-1" } },
  });
});

test("errorResponse preserves custom status and headers", async () => {
  const response = errorResponse("RATE_LIMITED", "Try again later.", {
    status: 429,
    headers: { "Retry-After": "17", "X-Contract-Test": "yes" },
  });

  assert.equal(response.status, 429);
  assert.equal(response.headers.get("Retry-After"), "17");
  assert.equal(response.headers.get("X-Contract-Test"), "yes");
  assert.deepEqual(await response.json(), {
    ok: false,
    error: { code: "RATE_LIMITED", message: "Try again later." },
  });
});

test("helper responses remain mutable for session cookies", () => {
  const response = successResponse(null);
  response.cookies.set("veevee_session", "signed-value", {
    httpOnly: true,
    path: "/",
  });

  const cookie = response.headers.get("set-cookie");
  assert.match(cookie, /veevee_session=signed-value/);
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /Path=\//i);
});

test("parseApiResponse normalizes canonical success and failure", async () => {
  const success = await parseApiResponse(
    Response.json({ ok: true, data: { user: null } })
  );
  const failure = await parseApiResponse(
    Response.json(
      { ok: false, error: { code: "UNAUTHENTICATED", message: "Sign in." } },
      { status: 401 }
    )
  );

  assert.deepEqual(success, { ok: true, data: { user: null }, error: null });
  assert.deepEqual(failure, {
    ok: false,
    data: null,
    error: { code: "UNAUTHENTICATED", message: "Sign in." },
  });
});

test("parseApiResponse normalizes legacy success and string errors", async () => {
  const success = await parseApiResponse(Response.json({ user: { id: "legacy" } }));
  const namedFailure = await parseApiResponse(
    Response.json({ error: "UNAUTHENTICATED" }, { status: 401 })
  );
  const messageFailure = await parseApiResponse(
    Response.json({ error: "Name is required." }, { status: 400 })
  );

  assert.deepEqual(success, {
    ok: true,
    data: { user: { id: "legacy" } },
    error: null,
  });
  assert.deepEqual(namedFailure, {
    ok: false,
    data: null,
    error: { code: "UNAUTHENTICATED", message: "UNAUTHENTICATED" },
  });
  assert.deepEqual(messageFailure, {
    ok: false,
    data: null,
    error: { code: "REQUEST_FAILED", message: "Name is required." },
  });
});

test("parseApiResponse rejects non-JSON and malformed canonical responses", async () => {
  const nonJson = await parseApiResponse(
    new Response("gateway error", { status: 502, headers: { "Content-Type": "text/plain" } })
  );
  const malformed = await parseApiResponse(
    Response.json({ ok: false, error: "missing structured error" }, { status: 400 })
  );

  const expected = {
    ok: false,
    data: null,
    error: {
      code: "INVALID_RESPONSE",
      message: "Server returned an invalid response.",
    },
  };
  assert.deepEqual(nonJson, expected);
  assert.deepEqual(malformed, expected);
});
