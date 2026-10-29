"use client";

/**
 * Formatting commands for the one rich-text editor open on the board. They
 * act on the browser selection inside that editor, which `readRichDom` reads
 * back (and sanitizes) when the edit commits. `execCommand` is deprecated
 * but remains the only cross-browser way to format a live contentEditable
 * selection, including a collapsed caret's typing style.
 */
import { cssColorToHex, highlightBackground, isSafeHref } from "./rich-text";

export const EDITOR_SELECTOR = "[data-rich-editor]";
/** Controls that may take focus without ending the edit. */
export const FORMAT_CONTROL_SELECTOR = "[data-rich-format]";

const COMMANDS = { b: "bold", i: "italic", u: "underline", s: "strikeThrough" };

function editorFor(node) {
  const el = node?.nodeType === 1 ? node : node?.parentElement;
  return el?.closest?.(EDITOR_SELECTOR) ?? null;
}

/** The open editor element, if the current selection is inside it. */
export function activeEditor() {
  if (typeof document === "undefined") return null;
  const selection = document.getSelection();
  return selection?.rangeCount ? editorFor(selection.getRangeAt(0).commonAncestorContainer) : null;
}

export function toggleFormat(kind) {
  if (!activeEditor()) return false;
  document.execCommand("styleWithCSS", false, false);
  return document.execCommand(COMMANDS[kind], false);
}

/** `color` is a #rrggbb highlight, or null to clear it. */
export function applyHighlight(color) {
  if (!activeEditor()) return false;
  return document.execCommand("hiliteColor", false, color ? highlightBackground(color) : "transparent");
}

/** Saves the editor selection so a link field can take focus and restore it. */
export function saveSelection() {
  const editor = activeEditor();
  if (!editor) return null;
  return { editor, range: document.getSelection().getRangeAt(0).cloneRange() };
}

export function restoreSelection(saved) {
  if (!saved?.editor?.isConnected) return false;
  saved.editor.focus();
  const selection = document.getSelection();
  selection.removeAllRanges();
  selection.addRange(saved.range);
  return true;
}

/** Links the restored selection to `href`, or removes links when it is empty. */
export function applyLink(saved, href) {
  if (!restoreSelection(saved)) return false;
  if (!href) return document.execCommand("unlink", false);
  if (!isSafeHref(href)) return false;
  return document.execCommand("createLink", false, href);
}

/** Normalizes what a person types into a link field: bare domains get https. */
export function normalizeHref(value) {
  const href = value.trim();
  if (!href) return "";
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return href;
  if (/^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/.test(href)) return `mailto:${href}`;
  return `https://${href}`;
}

/** Formats active at the current selection, for the format bar's pressed states. */
export function activeFormats() {
  const editor = activeEditor();
  if (!editor) return {};
  const formats = {};
  for (const [kind, command] of Object.entries(COMMANDS)) {
    try {
      formats[kind] = document.queryCommandState(command);
    } catch {
      formats[kind] = false;
    }
  }
  const selection = document.getSelection();
  let el = selection.anchorNode?.nodeType === 1 ? selection.anchorNode : selection.anchorNode?.parentElement;
  while (el && el !== editor) {
    if (!formats.a && el.tagName === "A") formats.a = el.getAttribute("href");
    if (!formats.h && el.style?.backgroundColor) formats.h = cssColorToHex(el.style.backgroundColor);
    el = el.parentElement;
  }
  return formats;
}

const linkListeners = new Set();

/** Cmd+K in the editor asks the format bar to open its link field. */
export function onLinkRequest(listener) {
  linkListeners.add(listener);
  return () => linkListeners.delete(listener);
}

export function requestLink() {
  for (const listener of linkListeners) listener();
}
