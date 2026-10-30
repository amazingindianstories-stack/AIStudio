"use client";

import { Fragment, useLayoutEffect, useRef } from "react";
import {
  clipRichText,
  highlightBackground,
  isHighlightColor,
  isSafeHref,
  plainTextFromClipboard,
  readRichDom,
  richSegments,
  writeRichDom,
} from "@/lib/canvas/rich-text";
import { FORMAT_CONTROL_SELECTOR, requestLink, toggleFormat } from "@/lib/canvas/rich-text-commands";
import { handleListKey } from "@/lib/canvas/list-commands";
import { displayLines, renumberLists } from "@/lib/canvas/lists";
import { cn } from "@/lib/utils";

/**
 * Formatted text as React elements: no HTML strings are ever rendered.
 * Links open in a new tab on a plain click when `openLinks` is set (a
 * read-only board) and on Cmd/Ctrl+click otherwise, so a click on an
 * editable board still selects the node.
 */
export function RichTextContent({ text, marks, openLinks = false }) {
  const segments = richSegments(text, marks);
  const lines = displayLines(text);
  if (!lines) return renderSegments(segments, openLinks);
  // List items get a hanging indent: wrapped lines align with the item's text, not its marker.
  return lines.map((line) => {
    if (line.level < 0) {
      return (
        <span key={line.start} className="block">
          {line.end > line.start ? renderSegments(clipSegments(segments, line.start, line.end), openLinks) : <br />}
        </span>
      );
    }
    const markerEnd = line.start + line.prefix;
    return (
      <span
        key={line.start}
        className="block"
        style={{ paddingLeft: `${line.level * LIST_INDENT_EM + MARKER_EM}em`, textIndent: `-${MARKER_EM}em` }}
      >
        <span className="inline-block indent-0" style={{ minWidth: `${MARKER_EM}em` }}>
          {renderSegments(clipSegments(segments, line.start + line.level, markerEnd), openLinks)}
        </span>
        {renderSegments(clipSegments(segments, markerEnd, line.end), openLinks)}
      </span>
    );
  });
}

/** Nesting step and marker width of list items, in em. */
const LIST_INDENT_EM = 1.5;
const MARKER_EM = 1.25;

/** The parts of `segments` inside [from, to). */
function clipSegments(segments, from, to) {
  const out = [];
  for (const segment of segments) {
    const end = segment.start + segment.text.length;
    if (end <= from || segment.start >= to) continue;
    const start = Math.max(segment.start, from);
    out.push({ ...segment, start, text: segment.text.slice(start - segment.start, Math.min(end, to) - segment.start) });
  }
  return out;
}

function renderSegments(segments, openLinks) {
  return segments.map((segment) => {
    let content = segment.text;
    if (segment.s) content = <s>{content}</s>;
    if (segment.u) content = <u>{content}</u>;
    if (segment.i) content = <i>{content}</i>;
    if (segment.b) content = <b className="font-bold">{content}</b>;
    if (isHighlightColor(segment.h)) {
      content = <span className="rounded-[2px]" style={{ backgroundColor: highlightBackground(segment.h) }}>{content}</span>;
    }
    if (isSafeHref(segment.a)) {
      content = (
        <a
          href={segment.a}
          target="_blank"
          rel="noopener noreferrer nofollow"
          title={openLinks ? segment.a : `${segment.a} (⌘-click to open)`}
          className="pointer-events-auto underline decoration-sky-400 decoration-2 underline-offset-2"
          onClick={(e) => {
            if (!openLinks && !e.metaKey && !e.ctrlKey) e.preventDefault();
          }}
        >
          {content}
        </a>
      );
    }
    return <Fragment key={segment.start}>{content}</Fragment>;
  });
}

/**
 * In-place editor. The editable DOM is owned by the browser while it is open
 * (React renders no children into it), seeded once from `text`/`marks` and
 * read back through `readRichDom` on commit, with its content height. It commits on blur, on
 * Cmd/Ctrl+Enter, and when it closes for any other reason (for example the
 * selection moving on); Escape discards the edit. With `maxLength`, typing and
 * pasting stop at that many characters.
 */
export function RichTextEditor({ text, marks, onCommit, onCancel, onInput, className, style, maxLength }) {
  const ref = useRef(null);
  const settled = useRef(false);
  // What this edit opened with, so a commit that typed nothing keeps another person's newer text.
  const seeded = useRef({ text, marks });
  const callbacks = useRef({ onCommit, onCancel });
  callbacks.current = { onCommit, onCancel };
  const limit = useRef(maxLength);
  limit.current = maxLength;

  const commit = () => {
    if (settled.current || !ref.current) return;
    settled.current = true;
    const value = readEditor(ref.current, limit.current);
    // The laid-out content height lets a text box grow to fit what was typed.
    callbacks.current.onCommit(value.text, value.marks, ref.current.scrollHeight, seeded.current);
  };

  useLayoutEffect(() => {
    const el = ref.current;
    const opened = seeded.current;
    writeRichDom(el, text, marks);
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    // Typed text (execCommand insertions are checked where they are made).
    const onBeforeInput = (e) => {
      if (e.inputType.startsWith("insert") && e.inputType !== "insertCompositionText" && room(el, limit.current) < (e.data?.length || 1)) {
        e.preventDefault();
      }
    };
    el.addEventListener("beforeinput", onBeforeInput);
    return () => {
      el.removeEventListener("beforeinput", onBeforeInput);
      // React's StrictMode re-runs this effect without unmounting; only an
      // editor that has really left the page commits here.
      queueMicrotask(() => {
        if (settled.current || el.isConnected) return;
        settled.current = true;
        const value = readEditor(el, limit.current);
        callbacks.current.onCommit(value.text, value.marks, undefined, opened);
      });
    };
    // Seeded once per open editor; later prop changes are this edit's own commits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      ref={ref}
      data-rich-editor=""
      role="textbox"
      aria-multiline="true"
      aria-label="Edit text"
      contentEditable
      suppressContentEditableWarning
      spellCheck
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onBlur={(e) => {
        if (e.relatedTarget?.closest?.(FORMAT_CONTROL_SELECTOR)) return;
        commit();
      }}
      onPaste={(e) => {
        e.preventDefault();
        const pasted = plainTextFromClipboard(e.clipboardData);
        const fits = clipRichText(pasted, null, room(e.currentTarget, maxLength)).text;
        if (fits) document.execCommand("insertText", false, fits);
      }}
      onDrop={(e) => e.preventDefault()}
      onInput={onInput}
      onKeyDown={(e) => {
        const mod = e.metaKey || e.ctrlKey;
        const key = e.key.toLowerCase();
        if (e.key === "Escape") {
          e.preventDefault();
          settled.current = true;
          callbacks.current.onCancel();
        } else if (mod && e.key === "Enter") {
          e.preventDefault();
          e.currentTarget.blur();
        } else if (e.key === "Enter" && !e.nativeEvent.isComposing && room(e.currentTarget, maxLength) < 1) {
          e.preventDefault();
        } else if (handleListKey(e.currentTarget, e.nativeEvent)) {
          e.preventDefault();
        } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
          // One newline character rather than browser-specific block markup.
          e.preventDefault();
          document.execCommand("insertText", false, "\n");
        } else if (mod && !e.altKey && !e.shiftKey && (key === "b" || key === "i" || key === "u")) {
          e.preventDefault();
          toggleFormat(key);
        } else if (mod && e.shiftKey && key === "x") {
          e.preventDefault();
          toggleFormat("s");
        } else if (mod && !e.shiftKey && key === "k") {
          e.preventDefault();
          requestLink();
        }
      }}
      className={cn("select-text", className)}
      style={{ tabSize: `${LIST_INDENT_EM}em`, ...style }}
    />
  );
}

/** The editor's value, with numbered lists counting from 1 again, within `maxLength`. */
function readEditor(el, maxLength) {
  const value = readRichDom(el);
  const renumbered = renumberLists(value.text, value.marks);
  return maxLength ? clipRichText(renumbered.text, renumbered.marks, maxLength) : renumbered;
}

/** How many characters the editor can still take in place of its selection. */
function room(el, maxLength) {
  if (!maxLength) return Infinity;
  const selection = window.getSelection();
  const selected = selection?.rangeCount && el.contains(selection.anchorNode) ? selection.toString().length : 0;
  return maxLength - readRichDom(el).text.length + selected;
}
