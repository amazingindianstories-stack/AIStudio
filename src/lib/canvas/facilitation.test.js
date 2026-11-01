import assert from "node:assert/strict";
import test from "node:test";
import {
  canAddVote,
  canRemoveVote,
  chimeDue,
  clockOffset,
  durationLabel,
  formatClock,
  remainingMs,
  revealCountdown,
  votable,
  votesLeft,
} from "./facilitation.js";

test("the clock offset puts local time on the server's clock", () => {
  const offset = clockOffset(10_000, 1_000, 1_100);
  assert.equal(offset, 8_950);
  const timer = { state: "running", endsAt: 70_000, run: 1 };
  assert.equal(remainingMs(timer, offset, 1_050), 60_000);
});

test("remaining time counts down, holds while paused and stops at zero", () => {
  assert.equal(remainingMs({ state: "running", endsAt: 5_000 }, 0, 1_000), 4_000);
  assert.equal(remainingMs({ state: "running", endsAt: 5_000 }, 0, 9_000), 0);
  assert.equal(remainingMs({ state: "paused", remainingMs: 7_000 }, 0, 99_000), 7_000);
  assert.equal(remainingMs({ state: "stopped" }, 0, 0), null);
  assert.equal(remainingMs(null, 0, 0), null);
});

test("the clock reads minutes and seconds and rounds a partial second up", () => {
  assert.equal(formatClock(247_000), "4:07");
  assert.equal(formatClock(8_100), "0:09");
  assert.equal(formatClock(0), "0:00");
  assert.equal(formatClock(3_723_000), "1:02:03");
});

test("the chime rings once per run, only at zero", () => {
  const timer = { state: "running", endsAt: 5_000, run: 3 };
  assert.equal(chimeDue(timer, 0, 4_000, 2), false);
  assert.equal(chimeDue(timer, 0, 5_000, 2), true);
  assert.equal(chimeDue(timer, 0, 5_000, 3), false);
  assert.equal(chimeDue({ ...timer, state: "paused" }, 0, 9_000, 2), false);
});

test("an object is votable by type and by the area the session is limited to", () => {
  const sticky = { id: "a", type: "sticky", x: 0, y: 0, w: 100, h: 100, parentId: "f" };
  assert.equal(votable({}, sticky), true);
  assert.equal(votable({ objectTypes: ["image"] }, sticky), false);
  assert.equal(votable({ objectTypes: ["sticky"] }, sticky), true);
  assert.equal(votable({ area: { frameId: "f" } }, sticky), true);
  assert.equal(votable({ area: { frameId: "g" } }, sticky), false);
  assert.equal(votable({ area: { x: 0, y: 0, w: 60, h: 60 } }, sticky), true);
  assert.equal(votable({ area: { x: 500, y: 0, w: 60, h: 60 } }, sticky), false);
  assert.equal(votable({}, null), false);
});

test("a person can add votes while any are left and remove only their own", () => {
  const session = { votesPerPerson: 3, votesUsed: 2, myVotes: { a: 2 }, done: false };
  assert.equal(votesLeft(session), 1);
  assert.equal(canAddVote(session, "b"), true);
  assert.equal(canAddVote({ ...session, votesUsed: 3 }, "b"), false);
  assert.equal(canAddVote({ ...session, done: true }, "b"), false);
  assert.equal(canAddVote({ ...session, oneVotePerObject: true }, "a"), false);
  assert.equal(canAddVote({ ...session, oneVotePerObject: true }, "b"), true);
  assert.equal(canRemoveVote(session, "a"), true);
  assert.equal(canRemoveVote(session, "b"), false);
});

test("the reveal countdown shows whole seconds and ends", () => {
  const mode = { active: true, revealAt: 10_000 };
  assert.equal(revealCountdown(mode, 0, 5_100), 5);
  assert.equal(revealCountdown(mode, 0, 9_999), 1);
  assert.equal(revealCountdown(mode, 0, 10_000), null);
  assert.equal(revealCountdown({ active: true, revealAt: null }, 0, 0), null);
  assert.equal(revealCountdown({ active: false, revealAt: 10_000 }, 0, 0), null);
});

test("duration labels read naturally", () => {
  assert.equal(durationLabel(null), "No limit");
  assert.equal(durationLabel(45_000), "45 sec");
  assert.equal(durationLabel(180_000), "3 min");
  assert.equal(durationLabel(90_000), "1 min 30 sec");
  assert.equal(durationLabel(3_900_000), "1 h 5 min");
});
