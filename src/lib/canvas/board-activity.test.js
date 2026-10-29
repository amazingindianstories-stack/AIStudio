import assert from "node:assert/strict";
import test from "node:test";
import { describeChange, formatDay, formatWhen, groupActivity } from "./board-activity.js";

const at = (day, hour, minute = 0) => new Date(2026, 9, day, hour, minute).getTime();
const entry = (actorId, when, extra = {}) => ({ actorId, action: "edit", nodeId: `n-${when}`, nodeType: "sticky", snippet: null, at: when, ...extra });

test("history groups consecutive changes by one person on one day, newest first", () => {
  const rows = [entry("ana", at(29, 15)), entry("ana", at(29, 14)), entry("ben", at(29, 13)), entry("ana", at(29, 12)), entry("ana", at(28, 23))];
  const groups = groupActivity(rows);
  assert.deepEqual(groups.map((group) => [group.actorId, group.entries.length, group.at]), [
    ["ana", 2, at(29, 15)],
    ["ben", 1, at(29, 13)],
    ["ana", 1, at(29, 12)],
    ["ana", 1, at(28, 23)],
  ]);
  assert.equal(new Set(groups.map((group) => group.key)).size, groups.length);
  assert.deepEqual(groupActivity([]), []);
});

test("changes read as an action and an object type", () => {
  assert.equal(describeChange({ action: "add", nodeType: "sticky" }), "Added sticky note");
  assert.equal(describeChange({ action: "edit", nodeType: "ellipse" }), "Edited circle");
  assert.equal(describeChange({ action: "delete", nodeType: "connector" }), "Deleted connector");
  assert.equal(describeChange({ action: "delete", nodeType: "widget" }), "Deleted object");
});

test("times read relative to now", () => {
  const now = at(29, 15, 30);
  assert.equal(formatWhen(now - 20_000, now), "just now");
  assert.equal(formatWhen(now - 5 * 60_000, now), "5 min ago");
  assert.match(formatWhen(at(29, 9, 5), now), /^Today 0?9[:.]05/);
  assert.match(formatWhen(at(28, 9, 5), now), /^Yesterday /);
  assert.equal(formatDay(at(29, 1), now), "Today");
  assert.doesNotMatch(formatDay(at(3, 1), now), /Today|Yesterday|2026/);
  assert.match(formatDay(new Date(2025, 9, 3).getTime(), now), /2025/);
});
