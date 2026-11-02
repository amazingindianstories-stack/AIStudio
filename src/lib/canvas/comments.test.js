import assert from "node:assert/strict";
import test from "node:test";
import { bodyParts, driftedAnchors, insertMention, moveAnchor, mentionQueryAt, mentionToken, mergeComments, mentionsUser, newestUpdate, pinPosition, plainBody, threadAnchor,
  threadsOf, unreadIds, unreadThreads, visibleThreads } from "./comments.js";

const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const comment = (id, extra = {}) => ({ id, parentId: null, createdAt: 1, updatedAt: 1, read: true, deleted: false, ...extra });

test("mention tokens round trip into chips and plain text", () => {
  const body = `hi ${mentionToken("Asha", `user:${ID}`)} and ${mentionToken("board", "board")}!`;
  assert.deepEqual(bodyParts(body), [
    { type: "text", text: "hi " },
    { type: "mention", label: "Asha", target: `user:${ID}`, userId: ID },
    { type: "text", text: " and " },
    { type: "mention", label: "board", target: "board", userId: null },
    { type: "text", text: "!" },
  ]);
  assert.equal(plainBody(body), "hi @Asha and @board!");
  assert.equal(plainBody("no mentions @[bad](nope)"), "no mentions @[bad](nope)");
});

test("typing @ finds the query before the caret and inserting replaces it", () => {
  assert.equal(mentionQueryAt("hello", 5), null);
  assert.equal(mentionQueryAt("a@b", 3), null);
  const query = mentionQueryAt("ping @as", 8);
  assert.deepEqual(query, { start: 5, query: "as" });
  const inserted = insertMention("ping @as later", 8, query, "@[Asha](board)");
  assert.equal(inserted.text, "ping @[Asha](board)  later");
  assert.equal(inserted.caret, "ping @[Asha](board) ".length);
});

test("threads group replies under roots in order and drop deleted comments", () => {
  const threads = threadsOf([
    comment("b", { createdAt: 5 }),
    comment("a", { createdAt: 2 }),
    comment("r2", { parentId: "a", createdAt: 4 }),
    comment("r1", { parentId: "a", createdAt: 3 }),
    comment("gone", { createdAt: 1, deleted: true }),
  ]);
  assert.deepEqual(threads.map((t) => [t.root.id, t.replies.map((r) => r.id)]), [["a", ["r1", "r2"]], ["b", []]]);
});

test("merging polled comments keeps the newest and removes deleted ones", () => {
  const known = new Map([["a", comment("a", { updatedAt: 5, body: "new" })], ["b", comment("b")]]);
  const next = mergeComments(known, [comment("a", { updatedAt: 3, body: "old" }), comment("b", { deleted: true, updatedAt: 9 }), comment("c", { updatedAt: 7 })]);
  assert.equal(next.get("a").body, "new");
  assert.equal(next.has("b"), false);
  assert.equal(next.has("c"), true);
  assert.equal(known.has("b"), true);
  assert.equal(newestUpdate([comment("x", { updatedAt: 4 }), comment("y", { updatedAt: 8 })], 2), 8);
});

test("a pin follows its object and falls back to where it was placed", () => {
  const root = comment("a", { anchor: { nodeId: "n", dx: 10, dy: 5 }, x: 1, y: 2 });
  assert.deepEqual(pinPosition(root, new Map([["n", { x: 100, y: 200 }]])), { x: 110, y: 205, attached: true });
  assert.deepEqual(pinPosition(root, new Map()), { x: 1, y: 2, attached: false });
  assert.equal(pinPosition(comment("b"), new Map()), null);
  assert.deepEqual(threadAnchor({ x: 15, y: 20 }, { id: "n", x: 10, y: 10 }), { anchorNodeId: "n", anchorDx: 5, anchorDy: 10, x: 15, y: 20 });
  assert.deepEqual(threadAnchor({ x: 1, y: 2 }, null), { x: 1, y: 2 });
});

test("unread state is counted per thread and resolved threads hide unless asked for", () => {
  const all = [comment("a", { read: false }), comment("r", { parentId: "b", read: false }), comment("b"), comment("c", { read: false, deleted: true })];
  assert.deepEqual([...unreadThreads(all)].sort(), ["a", "b"]);
  assert.deepEqual(unreadIds(all), ["a", "r"]);
  assert.deepEqual(unreadIds(all, "b"), ["r"]);
  const threads = [{ root: comment("a", { resolvedAt: 5 }), replies: [] }, { root: comment("b"), replies: [] }];
  assert.equal(visibleThreads(threads, { showResolved: false }).length, 1);
  assert.equal(visibleThreads(threads, { showResolved: true }).length, 2);
  assert.equal(mentionsUser({ mentions: { users: [ID] } }, ID.toUpperCase()), true);
  assert.equal(mentionsUser({}, ID), false);
});

test("a thread falls back to its object's last position after the object is deleted", () => {
  const root = comment(ID, { anchor: { nodeId: "n1", dx: 5, dy: 6 }, x: 105, y: 106 });
  const moved = new Map([["n1", { id: "n1", x: 300, y: 400 }]]);
  // The object moved: the stored fallback is stale and a refresh is due, anchor unchanged.
  assert.deepEqual(driftedAnchors([{ root }], moved), [{ id: ID, body: { anchorNodeId: "n1", anchorDx: 5, anchorDy: 6, x: 305, y: 406 } }]);
  // Once stored, nothing more to refresh, and deleting the object leaves the pin at that last position.
  const stored = { ...root, x: 305, y: 406 };
  assert.deepEqual(driftedAnchors([{ root: stored }], moved), []);
  assert.deepEqual(pinPosition(stored, new Map()), { x: 305, y: 406, attached: false });
  // Free-standing and deleted threads never drift.
  assert.deepEqual(driftedAnchors([{ root: comment("b", { x: 1, y: 2 }) }, { root: { ...root, deleted: true } }], moved), []);
});

test("dragging a pin re-anchors it onto an object or detaches it on empty canvas", () => {
  assert.deepEqual(moveAnchor({ x: 50, y: 60 }, { id: "n2", x: 40, y: 40 }), { anchorNodeId: "n2", anchorDx: 10, anchorDy: 20, x: 50, y: 60 });
  assert.deepEqual(moveAnchor({ x: 50, y: 60 }, null), { anchorNodeId: null, anchorDx: null, anchorDy: null, x: 50, y: 60 });
});
