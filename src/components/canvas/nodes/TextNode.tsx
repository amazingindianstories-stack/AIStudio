"use client";

import { useEffect, useRef } from "react";
import type { TextNode as TextNodeData } from "@/lib/canvas/types";

/**
 * Plain text box. `contentEditable` only while `editing` (driven by
 * `canvas-store`'s `editingTextId`) — otherwise a static, non-interactive
 * label so it doesn't fight node drag/selection.
 */
export function TextNode({
  node,
  editing,
  onCommit,
  onCancel,
}: {
  node: TextNodeData;
  editing: boolean;
  onCommit: (text: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

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
        if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
          e.preventDefault();
          e.currentTarget.blur();
        }
      }}
      className="h-full w-full overflow-hidden whitespace-pre-wrap break-words outline-none"
      style={{
        fontSize: node.fontSize,
        color: node.color,
        textAlign: node.align,
        cursor: editing ? "text" : undefined,
      }}
    >
      {node.text ||
        (editing ? "" : <span className="text-white/25">Text</span>)}
    </div>
  );
}
