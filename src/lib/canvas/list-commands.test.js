import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { handleListKey } from "./list-commands";

const { document } = new JSDOM("<!doctype html><body></body>").window;

function editorWithCaret(html, place) {
  const root = document.createElement("div");
  root.contentEditable = "true";
  root.innerHTML = html;
  document.body.replaceChildren(root);
  const [node, offset] = place(root);
  const range = document.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  const selection = document.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  return root;
}

const key = (name, extra = {}) => ({ key: name, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, isComposing: false, ...extra });

test("on the empty line after a list ends, Enter and Tab are the editor's own, not the item's above", () => {
  const emptyLine = (root) => [root.lastChild, 0];
  assert.equal(handleListKey(editorWithCaret("• a<div><br></div>", emptyLine), key("Enter")), false);
  assert.equal(handleListKey(editorWithCaret("<div>• a</div><div><br></div>", emptyLine), key("Tab")), false);
  // At the start of a line's text, the caret is on that line too.
  const lineStart = (root) => [root.lastChild.firstChild, 0];
  assert.equal(handleListKey(editorWithCaret("• a<div>plain</div>", lineStart), key("Enter")), false);
});
