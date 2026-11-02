import test from "node:test";
import assert from "node:assert/strict";
import { resolveRefs, withNotesRefs, withNotesText, withoutNotesRef } from "./notes";
import { MAX_NOTES_REFS } from "./extras";

test("an empty note with no links is no note", () => {
  assert.equal(withNotesText({ text: "a" }, "", []), null);
  assert.deepEqual(withNotesText(null, "hi", [[0, 2, "b"]]), { text: "hi", marks: [[0, 2, "b"]] });
});

test("typing keeps the links and drops stale marks", () => {
  const next = withNotesText({ text: "a", marks: [[0, 1, "b"]], refs: [{ id: "n1", type: "frame", label: "F" }] }, "ab", []);
  assert.deepEqual(next, { text: "ab", refs: [{ id: "n1", type: "frame", label: "F" }] });
});

test("links are added once, labelled, capped and removable", () => {
  const nodes = [{ id: "a", type: "sticky", text: "  hello   world " }, { id: "b", type: "frame", name: "Scene 1" }];
  let notes = withNotesRefs(null, nodes);
  assert.deepEqual(notes.refs.map((r) => r.label), ["hello world", "Scene 1"]);
  notes = withNotesRefs(notes, nodes);
  assert.equal(notes.refs.length, 2);
  const many = Array.from({ length: MAX_NOTES_REFS + 5 }, (_, i) => ({ id: `x${i}`, type: "text", text: "t" }));
  assert.equal(withNotesRefs(null, many).refs.length, MAX_NOTES_REFS);
  assert.equal(withoutNotesRef({ text: "", refs: [{ id: "a", type: "t", label: "" }] }, "a"), null);
  assert.equal(withoutNotesRef({ text: "x", refs: [{ id: "a", type: "t", label: "" }] }, "a").refs, undefined);
});

test("links to deleted objects are marked gone", () => {
  const notes = { text: "", refs: [{ id: "a", type: "t", label: "A" }, { id: "b", type: "t", label: "B" }] };
  assert.deepEqual(resolveRefs(notes, [{ id: "a" }]).map((r) => r.live), [true, false]);
});
