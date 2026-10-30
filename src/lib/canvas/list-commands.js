/**
 * List editing inside an open rich text editor (./lists.js holds the rules).
 * Each key reads the editor's text and caret, asks ./lists.js for the edit,
 * then selects the edited range and types the replacement through the
 * browser, so the edit joins the editor's own undo stack and keeps the
 * surrounding formatting markup.
 */
import { listOnEnter, listOnSpace, listOnTab } from "./lists";
import { readRichDom } from "./rich-text";

/** The editor's text and the caret's offset in it, or null without a collapsed caret inside `root`. */
function textAndCaret(root) {
  const selection = root.ownerDocument.getSelection();
  if (!selection?.rangeCount || !selection.isCollapsed || !root.contains(selection.focusNode)) return null;
  const range = root.ownerDocument.createRange();
  range.setStart(root, 0);
  range.setEnd(selection.focusNode, selection.focusOffset);
  const before = root.ownerDocument.createElement("div");
  before.appendChild(range.cloneContents());
  return { text: readRichDom(root).text, caret: readRichDom(before).text.length };
}

/** The DOM position of text offset `offset` in `root`, counting a <br> as one character. */
function domPoint(root, offset) {
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  let remaining = offset;
  let last = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType === 3) {
      if (remaining <= node.data.length) return { node, offset: remaining };
      remaining -= node.data.length;
      last = node;
    } else if (node.tagName === "BR") {
      if (remaining === 0) return { node: node.parentNode, offset: [...node.parentNode.childNodes].indexOf(node) };
      remaining -= 1;
    }
  }
  return last ? { node: last, offset: last.data.length } : { node: root, offset: root.childNodes.length };
}

function replaceRange(root, edit) {
  const doc = root.ownerDocument;
  const start = domPoint(root, edit.start);
  const end = domPoint(root, edit.end);
  const range = doc.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  const selection = doc.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  if (edit.insert) doc.execCommand("insertText", false, edit.insert);
  else if (edit.end > edit.start) doc.execCommand("delete");
}

/**
 * Handles a list key in the editor `root` (Enter, Space, Tab or Shift+Tab, as
 * a keydown event). Returns true when it made the edit, and the caller then
 * prevents the browser's own handling.
 */
export function handleListKey(root, event) {
  const key = event.key;
  if (key !== "Enter" && key !== " " && key !== "Tab") return false;
  if (event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return false;
  if (key !== "Tab" && event.shiftKey) return false;
  const state = textAndCaret(root);
  if (!state) return false;
  const edit =
    key === "Enter" ? listOnEnter(state.text, state.caret)
      : key === " " ? listOnSpace(state.text, state.caret)
        : listOnTab(state.text, state.caret, event.shiftKey);
  if (!edit) return false;
  // Tab keeps the caret where it was in the item's text, which the prefix change shifted.
  const after = state.caret + (key === "Tab" && state.caret >= edit.end ? edit.insert.length - (edit.end - edit.start) : 0);
  replaceRange(root, edit);
  if (key === "Tab") {
    const point = domPoint(root, Math.max(after, edit.start + edit.insert.length));
    const range = root.ownerDocument.createRange();
    range.setStart(point.node, point.offset);
    range.collapse(true);
    const selection = root.ownerDocument.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }
  return true;
}
