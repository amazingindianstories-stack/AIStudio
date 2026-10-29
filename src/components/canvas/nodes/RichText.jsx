"use client";

import { Fragment, useLayoutEffect, useRef } from "react";
import {
  highlightBackground,
  isHighlightColor,
  isSafeHref,
  plainTextFromClipboard,
  readRichDom,
  richSegments,
  writeRichDom,
} from "@/lib/canvas/rich-text";
import { FORMAT_CONTROL_SELECTOR, requestLink, toggleFormat } from "@/lib/canvas/rich-text-commands";
import { cn } from "@/lib/utils";

/**
 * Formatted text as React elements: no HTML strings are ever rendered.
 * Links open in a new tab on a plain click when `openLinks` is set (a
 * read-only board) and on Cmd/Ctrl+click otherwise, so a click on an
 * editable board still selects the node.
 */
export function RichTextContent({ text, marks, openLinks = false }) {
  return richSegments(text, marks).map((segment) => {
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
 * selection moving on); Escape discards the edit.
 */
export function RichTextEditor({ text, marks, onCommit, onCancel, className, style }) {
  const ref = useRef(null);
  const settled = useRef(false);
  // What this edit opened with, so a commit that typed nothing keeps another person's newer text.
  const seeded = useRef({ text, marks });
  const callbacks = useRef({ onCommit, onCancel });
  callbacks.current = { onCommit, onCancel };

  const commit = () => {
    if (settled.current || !ref.current) return;
    settled.current = true;
    const value = readRichDom(ref.current);
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
    return () => {
      // React's StrictMode re-runs this effect without unmounting; only an
      // editor that has really left the page commits here.
      queueMicrotask(() => {
        if (settled.current || el.isConnected) return;
        settled.current = true;
        const value = readRichDom(el);
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
        document.execCommand("insertText", false, plainTextFromClipboard(e.clipboardData));
      }}
      onDrop={(e) => e.preventDefault()}
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
      style={style}
    />
  );
}
