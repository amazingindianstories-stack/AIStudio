"use client";

import { useRef } from "react";
import { useCanvasStore } from "@/lib/canvas-store";
import { displayName } from "@/lib/board-access";
import { fontFamilyCss } from "@/lib/canvas/fonts";
import { stickyAuthor } from "@/lib/canvas/stickies";
import { tagsOf } from "@/lib/canvas/tags";
import { toggleStickyReaction, currentUserId } from "@/lib/canvas/sticky-actions";
import { usePeople } from "@/lib/canvas/use-people";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { RichTextContent, RichTextEditor } from "./RichText";
import { autoFitMax, useAutoFit } from "./use-auto-fit";

const TEXT_CLASS = "h-full w-full overflow-hidden whitespace-pre-wrap break-words outline-none";

/** FigJam-signature colored note block with editable text, its tags, votes and (when shown) author. */
export function StickyNode({ node, editing, readOnly, onCommit, onCancel }) {
  const fitRef = useRef(null);
  const autoFit = Boolean(node.autoFit);
  const refit = useAutoFit(fitRef, autoFit, autoFitMax(node.w, node.h),
    [editing, node.text, node.marks, node.w, node.h, node.fontFamily, node.tagIds, node.reactions, node.showAuthor]);
  // Auto font size sets the size on the measured box itself (useAutoFit).
  const style = { fontSize: autoFit ? undefined : node.fontSize, color: node.color, fontFamily: fontFamilyCss(node.fontFamily) };
  const hasFooter = Boolean(node.tagIds?.length || (node.reactions && Object.keys(node.reactions).length) || node.showAuthor);
  return (
    <div
      className="flex h-full w-full flex-col overflow-hidden rounded-md p-3 shadow-[0_6px_16px_rgba(0,0,0,0.35)]"
      style={{ background: node.fill }}
    >
      <div ref={fitRef} className="min-h-0 w-full flex-1 overflow-hidden" style={style}>
        {editing ? (
          <RichTextEditor
            text={node.text}
            marks={node.marks}
            onCommit={onCommit}
            onCancel={onCancel}
            onInput={refit}
            className={TEXT_CLASS}
            style={{ cursor: "text" }}
          />
        ) : (
          <div className={TEXT_CLASS}>
            {node.text ? (
              <RichTextContent text={node.text} marks={node.marks} openLinks={readOnly} />
            ) : (
              <span className="opacity-40">Sticky note</span>
            )}
          </div>
        )}
      </div>
      {hasFooter && <StickyFooter node={node} readOnly={readOnly} />}
    </div>
  );
}

function StickyFooter({ node, readOnly }) {
  const tags = useCanvasStore((s) => s.history.present.tags);
  const userId = useStore((s) => s.currentUser?.id ?? null);
  const shown = tagsOf(node, tags ?? []);
  const votes = Object.entries(node.reactions ?? {});
  return (
    <div className="mt-1.5 flex shrink-0 flex-wrap items-center gap-1 text-[11px] leading-4" style={{ color: node.color }}>
      {shown.map((tag) => (
        <span
          key={tag.id}
          data-sticky-tag={tag.name}
          className="max-w-full truncate rounded-full px-1.5 font-medium text-white"
          style={{ background: tag.color }}
        >
          {tag.name}
        </span>
      ))}
      {votes.map(([emoji, ids]) => {
        const mine = Boolean(userId && ids.includes(userId));
        return (
          <button
            key={emoji}
            type="button"
            data-sticky-reaction={emoji}
            aria-pressed={mine}
            aria-label={`${emoji} ${ids.length} ${ids.length === 1 ? "vote" : "votes"}${readOnly ? "" : mine ? ", remove your vote" : ", add your vote"}`}
            disabled={readOnly}
            onPointerDown={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              toggleStickyReaction(node.id, emoji);
            }}
            className={cn(
              "flex items-center gap-0.5 rounded-full border px-1.5 tabular-nums transition-colors",
              mine ? "border-black/40 bg-black/15" : "border-black/15 bg-white/25",
              readOnly ? "cursor-default" : "hover:bg-black/10"
            )}
          >
            <span aria-hidden>{emoji}</span>
            <span aria-hidden>{ids.length}</span>
          </button>
        );
      })}
      {node.showAuthor && <StickyAuthor node={node} />}
    </div>
  );
}

function StickyAuthor({ node }) {
  const people = usePeople();
  const author = stickyAuthor(node) ?? currentUserId();
  if (!author) return null;
  return (
    <span data-sticky-author="" className="ml-auto max-w-full truncate opacity-70">
      {displayName(people.get(author), author)}
    </span>
  );
}
