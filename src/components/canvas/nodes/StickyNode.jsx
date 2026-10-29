"use client";

import { useEffect, useRef } from "react";
import { useTextFrozenWhileEditing } from "./use-frozen-text";

/** FigJam-signature colored note block with editable text. */
export function StickyNode({
  node,
  editing,
  onCommit,
  onCancel,
}

) {
  const ref = useRef(null);
  const shownText = useTextFrozenWhileEditing(node.text, editing);

  useEffect(() => {
    if (!editing) return;
    const el = ref.current;
    if (!el) return;
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }, [editing]);

  return (
    <div
      className="h-full w-full overflow-hidden rounded-md p-3 shadow-[0_6px_16px_rgba(0,0,0,0.35)]"
      style={{ background: node.fill }}
    >
      <div
        ref={ref}
        contentEditable={editing}
        suppressContentEditableWarning
        onPointerDown={(e) => editing && e.stopPropagation()}
        onBlur={(e) => editing && onCommit(e.currentTarget.textContent ?? "")}
        onKeyDown={(e) => {
          if (!editing) return;
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        className="h-full w-full overflow-hidden whitespace-pre-wrap break-words outline-none"
        style={{
          fontSize: node.fontSize,
          color: node.color,
          cursor: editing ? "text" : undefined,
        }}
      >
        {shownText || (editing ? "" : <span className="opacity-40">Sticky note</span>)}
      </div>
    </div>
  );
}
