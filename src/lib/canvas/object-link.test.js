import assert from "node:assert/strict";
import test from "node:test";
import { objectLink, parseObjectLink, withoutLinkParams } from "./object-link.js";

test("builds links to a board or to one object on it", () => {
  assert.equal(objectLink("https://veevee.app", { project: "p1", board: "b1", object: "n1" }), "https://veevee.app/?project=p1&board=b1&object=n1");
  assert.equal(objectLink("https://veevee.app/x?y=1", { board: "b1" }), "https://veevee.app/?board=b1");
});

test("parses a link and ignores malformed ids", () => {
  assert.deepEqual(parseObjectLink("?project=p1&board=b1&object=n1"), { project: "p1", board: "b1", object: "n1" });
  assert.deepEqual(parseObjectLink("?board=b1&object=bad%20id"), { project: null, board: "b1", object: null });
  assert.equal(parseObjectLink("?object=n1"), null);
  assert.equal(parseObjectLink("?board=../etc"), null);
});

test("removes only the link parameters from the address", () => {
  assert.equal(withoutLinkParams("https://veevee.app/?board=b1&object=n1&tab=library#top"), "https://veevee.app/?tab=library#top");
});
