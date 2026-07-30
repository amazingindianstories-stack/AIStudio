import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_LOG_QUERY_LENGTH,
  adminLogFilterToParams,
  parseAdminLogFilter,
  type AdminLogFilter,
} from "./admin-logs";

const parse = (qs: string) => parseAdminLogFilter(new URLSearchParams(qs));
const UUID = "6a0b7185-f565-4eb2-9d30-63e0bae8e963";

test("empty querystring is an empty filter", () => {
  assert.deepEqual(parse(""), {});
});

test("recognised filters are read", () => {
  assert.deepEqual(parse(`userId=${UUID}&kind=video&model=Seedance%202.0&status=failed&q=cat`), {
    userId: UUID,
    kind: "video",
    model: "Seedance 2.0",
    status: "failed",
    q: "cat",
  });
});

test("a non-uuid userId is dropped, not passed through to the query", () => {
  // It reaches an eq() against a uuid column; Postgres would raise on the cast.
  assert.deepEqual(parse("userId=../../etc/passwd"), {});
  assert.deepEqual(parse("userId=1 OR 1=1"), {});
});

test("only image and video are accepted as kind", () => {
  assert.equal(parse("kind=image").kind, "image");
  assert.equal(parse("kind=video").kind, "video");
  assert.equal(parse("kind=audio").kind, undefined);
  assert.equal(parse("kind=").kind, undefined);
});

test("status is restricted to real statuses", () => {
  for (const s of ["queued", "running", "succeeded", "failed"]) {
    assert.equal(parse(`status=${s}`).status, s);
  }
  assert.equal(parse("status=deleted").status, undefined);
});

test("search is trimmed and length-capped", () => {
  assert.equal(parse("q=%20%20hello%20%20").q, "hello");
  assert.equal(parse("q=" + "a".repeat(500)).q?.length, MAX_LOG_QUERY_LENGTH);
  // Whitespace-only is no filter at all, not an ILIKE on "".
  assert.equal(parse("q=%20%20").q, undefined);
});

test("filter → params → filter round-trips", () => {
  const filters: AdminLogFilter[] = [
    {},
    { kind: "image" },
    { userId: UUID, status: "succeeded" },
    { model: "Nano Banana Pro", q: "a man walking" },
    { userId: UUID, kind: "video", model: "Seedance 2.0", status: "failed", q: "x" },
  ];
  for (const filter of filters) {
    assert.deepEqual(
      parseAdminLogFilter(adminLogFilterToParams(filter)),
      filter,
      JSON.stringify(filter)
    );
  }
});

test("params carry only the keys that are set", () => {
  assert.equal(adminLogFilterToParams({}).toString(), "");
  assert.equal(adminLogFilterToParams({ kind: "video" }).toString(), "kind=video");
});

test("values needing escaping survive the round trip", () => {
  // Model names contain spaces and dots; prompts contain everything.
  const filter: AdminLogFilter = { model: "Higgsfield Seedance 2.0", q: "50% & \"more\"" };
  assert.deepEqual(parseAdminLogFilter(adminLogFilterToParams(filter)), filter);
});
