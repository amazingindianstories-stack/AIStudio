import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyTextEdits,
  displayLines,
  listItem,
  listOnEnter,
  listOnSpace,
  listOnTab,
  renumberLists,
} from "./lists";

const apply = (text, edit) => text.slice(0, edit.start) + edit.insert + text.slice(edit.end);

test("a list item is tabs, a marker and a space at the start of a line", () => {
  assert.deepEqual(listItem("• milk"), { level: 0, numbered: false, number: 0, prefix: 2 });
  assert.deepEqual(listItem("\t\t12. eggs"), { level: 2, numbered: true, number: 12, prefix: 6 });
  assert.equal(listItem("•milk"), null);
  assert.equal(listItem("- milk"), null);
  assert.equal(listItem("12 eggs"), null);
});

test("a dash or star and a space at the start of a line become a bullet", () => {
  assert.deepEqual(listOnSpace("ideas\n-", 7), { start: 6, end: 7, insert: "• " });
  assert.deepEqual(listOnSpace("\t*", 2), { start: 0, end: 2, insert: "\t◦ " });
  assert.equal(listOnSpace("a -", 3), null);
  assert.equal(listOnSpace("--", 2), null);
});

test("Enter continues a list, counts up, and ends it on an empty item", () => {
  assert.equal(apply("• milk", listOnEnter("• milk", 6)), "• milk\n• ");
  assert.equal(apply("\t3. eggs", listOnEnter("\t3. eggs", 8)), "\t3. eggs\n\t4. ");
  assert.equal(apply("• milk\n• ", listOnEnter("• milk\n• ", 9)), "• milk\n");
  // Enter inside the marker, or on plain text, is an ordinary newline.
  assert.equal(listOnEnter("• milk", 1), null);
  assert.equal(listOnEnter("milk", 4), null);
});

test("Tab nests and Shift+Tab un-nests the item, with the bullet of its level", () => {
  assert.equal(apply("• a\n• b", listOnTab("• a\n• b", 7, false)), "• a\n\t◦ b");
  assert.equal(apply("\t◦ b", listOnTab("\t◦ b", 4, true)), "• b");
  assert.equal(apply("\t2. b", listOnTab("\t2. b", 5, true)), "2. b");
  // At the outermost level Shift+Tab does nothing, and plain lines are left to the browser.
  assert.deepEqual(listOnTab("• b", 3, true), { start: 3, end: 3, insert: "" });
  assert.equal(listOnTab("b", 1, false), null);
});

test("text edits keep marks on the characters they covered", () => {
  // "bold" is bold; a marker replaced before it shifts the mark.
  const result = applyTextEdits("9. bold", [[3, 7, "b"]], [{ start: 0, end: 2, insert: "10." }]);
  assert.deepEqual(result, { text: "10. bold", marks: [[4, 8, "b"]] });
  // A mark over replaced text alone disappears; inserted text is not formatted.
  assert.deepEqual(applyTextEdits("ab", [[0, 1, "i"]], [{ start: 0, end: 1, insert: "" }]), { text: "b", marks: null });
  assert.deepEqual(applyTextEdits("ab", [[0, 2, "u"]], [{ start: 1, end: 1, insert: "X" }]), { text: "aXb", marks: [[0, 3, "u"]] });
  assert.deepEqual(applyTextEdits("ab", [[1, 2, "u"]], [{ start: 1, end: 1, insert: "X" }]), { text: "aXb", marks: [[2, 3, "u"]] });
});

test("numbered lists renumber from 1 per level and restart after other lines", () => {
  const text = "1. a\n1. b\n\t5. x\n\t5. y\n7. c\nplain\n4. d";
  assert.equal(renumberLists(text, undefined).text, "1. a\n2. b\n\t1. x\n\t2. y\n3. c\nplain\n1. d");
  const marked = renumberLists("1. a\n1. bold", [[8, 12, "b"]]);
  assert.deepEqual(marked, { text: "1. a\n2. bold", marks: [[8, 12, "b"]] });
  const same = { text: "1. a\n2. b", marks: undefined };
  assert.deepEqual(renumberLists(same.text, same.marks), same);
  // A bullet at the same level ends the numbering.
  assert.equal(renumberLists("1. a\n• b\n3. c", undefined).text, "1. a\n• b\n1. c");
});

test("display lines describe list items, and plain text has none", () => {
  assert.equal(displayLines("just text\nmore"), null);
  assert.deepEqual(displayLines("top\n\t• a"), [
    { start: 0, end: 3, level: -1, prefix: 0 },
    { start: 4, end: 8, level: 1, prefix: 3 },
  ]);
});
