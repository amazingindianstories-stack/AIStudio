import test from "node:test";
import assert from "node:assert/strict";
import { chatLabel } from "./ChatSidebar.jsx";

test("chatLabel shows a named chat's name and dates an untitled one so it never reads like the New chat button", () => {
  const now = new Date(2026, 10, 6, 15, 0).getTime();
  const today = new Date(2026, 10, 6, 14, 32).getTime();
  const earlier = new Date(2026, 10, 4, 9, 5).getTime();
  assert.equal(chatLabel({ name: "Spring hero", createdAt: today }, now), "Spring hero");
  const untitled = chatLabel({ name: "New chat", createdAt: today }, now);
  assert.match(untitled, /^Untitled chat · /);
  assert.ok(untitled.includes(new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(today)));
  const older = chatLabel({ name: "New chat", createdAt: earlier }, now);
  assert.ok(older.includes(new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).formatToParts(earlier)
    .find((part) => part.type === "day").value), older);
  assert.notEqual(older, untitled);
  assert.equal(chatLabel({ name: "New chat" }, now), "New chat", "no time to show");
  assert.equal(chatLabel(null), "");
});
