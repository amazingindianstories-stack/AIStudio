import assert from "node:assert/strict";
import test from "node:test";
import { loginUrlFor } from "./login-next.js";

test("loginUrlFor keeps the current path and query as an encoded next", () => {
  assert.equal(loginUrlFor({ pathname: "/", search: "?board=abc" }), "/login?next=%2F%3Fboard%3Dabc");
  assert.equal(loginUrlFor({ pathname: "/admin", search: "" }), "/login?next=%2Fadmin");
});

test("loginUrlFor sends the bare root to a plain /login", () => {
  assert.equal(loginUrlFor({ pathname: "/", search: "" }), "/login");
});
