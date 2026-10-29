"use client";

import { RichTextContent, RichTextEditor } from "./RichText";

const TEXT_CLASS = "h-full w-full overflow-hidden whitespace-pre-wrap break-words outline-none";

/** FigJam-signature colored note block with editable text. */
export function StickyNode({ node, editing, readOnly, onCommit, onCancel }) {
  const style = { fontSize: node.fontSize, color: node.color };
  return (
    <div
      className="h-full w-full overflow-hidden rounded-md p-3 shadow-[0_6px_16px_rgba(0,0,0,0.35)]"
      style={{ background: node.fill }}
    >
      {editing ? (
        <RichTextEditor
          text={node.text}
          marks={node.marks}
          onCommit={onCommit}
          onCancel={onCancel}
          className={TEXT_CLASS}
          style={{ ...style, cursor: "text" }}
        />
      ) : (
        <div className={TEXT_CLASS} style={style}>
          {node.text ? (
            <RichTextContent text={node.text} marks={node.marks} openLinks={readOnly} />
          ) : (
            <span className="opacity-40">Sticky note</span>
          )}
        </div>
      )}
    </div>
  );
}
