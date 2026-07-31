import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_ACTION_LENGTH,
  adminActivityFilterToParams,
  parseAdminActivityFilter,
  type AdminActivityFilter,
} from "./admin-activity";

/**
 * The parser is the trust boundary for the activity endpoint: everything it
 * returns goes into a query. Pure — no db, no network.
 */

const parse = (qs: string) => parseAdminActivityFilter(new URLSearchParams(qs));
const UUID = "6a0b7185-f565-4eb2-9d30-63e0bae8e963";

test("empty querystring is an empty filter", () => {
  assert.deepEqual(parse(""), {});
});

test("recognised filters are read", () => {
  assert.deepEqual(parse(`action=login&userId=${UUID}`), { action: "login", userId: UUID });
});

test("a non-uuid userId is dropped, not passed through to the query", () => {
  // It reaches an eq() against a uuid column; Postgres would raise on the cast.
  assert.deepEqual(parse("userId=not-a-uuid"), {});
  assert.deepEqual(parse("userId=1 OR 1=1"), {});
});

test("an unknown action is kept rather than whitelisted away", () => {
  // `action` is free text written by call sites; a whitelist here would make a
  // filter for a newly added action silently return everything instead.
  assert.equal(parse("action=some_future_action").action, "some_future_action");
});

test("action is length-capped", () => {
  const long = "x".repeat(MAX_ACTION_LENGTH + 50);
  assert.equal(parse(`action=${long}`).action?.length, MAX_ACTION_LENGTH);
});

test("a blank or whitespace action is dropped, not filtered on", () => {
  // An empty action must mean "all actions"; eq(action, '') would match nothing.
  assert.equal(parse("action=").action, undefined);
  assert.equal(parse("action=%20%20").action, undefined);
});

test("action is trimmed", () => {
  assert.equal(parse("action=%20login%20").action, "login");
});

test("unrelated params are ignored", () => {
  assert.deepEqual(parse("cursor=123.abc&limit=500&format=csv"), {});
});

test("filter → params → filter round-trips", () => {
  const filters: AdminActivityFilter[] = [
    {},
    { action: "generate" },
    { userId: UUID },
    { action: "delete_project", userId: UUID },
  ];
  for (const f of filters) {
    assert.deepEqual(parseAdminActivityFilter(adminActivityFilterToParams(f)), f);
  }
});

test("params omit absent filters entirely", () => {
  assert.equal(adminActivityFilterToParams({}).toString(), "");
  assert.equal(adminActivityFilterToParams({ action: "login" }).toString(), "action=login");
});
