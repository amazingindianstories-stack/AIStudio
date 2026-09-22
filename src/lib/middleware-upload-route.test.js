import test from "node:test";
import assert from "node:assert/strict";
import { middleware } from "../middleware.js";

function request(sessionValue) {
  return {
    nextUrl: {
      pathname: "/api/uploads/presign",
      clone() { return new URL("https://www.veevee.ai/api/uploads/presign"); },
    },
    cookies: { get: () => sessionValue ? { value: sessionValue } : undefined },
  };
}

test("authenticated browser presign requests pass through edge middleware", () => {
  const response = middleware(request("session-token"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-middleware-next"), "1");
});

test("unauthenticated browser presign requests receive 401, never 403", async () => {
  const response = middleware(request());
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "UNAUTHENTICATED" });
});
