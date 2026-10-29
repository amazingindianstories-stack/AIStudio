"use client";

import { RichTextContent, RichTextEditor } from "./RichText";

const TEXT_CLASS = "h-full w-full overflow-hidden whitespace-pre-wrap break-words outline-none";

/**
 * Text box. Editable only while `editing` (driven by `canvas-store`'s
 * `editingTextId`); otherwise a static label so it doesn't fight node
 * drag/selection.
 */
export function TextNode({ node, editing, readOnly, onCommit, onCancel }) {
  const style = { fontSize: node.fontSize, color: node.color, textAlign: node.align };
  if (editing) {
    return (
      <RichTextEditor
        text={node.text}
        marks={node.marks}
        onCommit={onCommit}
        onCancel={onCancel}
        className={TEXT_CLASS}
        style={{ ...style, cursor: "text" }}
      />
    );
  }
  return (
    <div className={TEXT_CLASS} style={style}>
      {node.text ? (
        <RichTextContent text={node.text} marks={node.marks} openLinks={readOnly} />
      ) : (
        <span className="text-white/25">Text</span>
      )}
    </div>
  );
}
