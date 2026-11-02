"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { MessageSquare } from "lucide-react";
import { cn } from "@/lib/utils";
import { useCanvasStore } from "@/lib/canvas-store";
import { hitTest, screenToWorld, worldToScreen } from "@/lib/canvas/geometry";
import { COMMENT_COLORS, driftedAnchors, moveAnchor, pinPosition, threadAnchor, unreadThreads, visibleThreads } from "@/lib/canvas/comments";
import { useCommentsStore } from "@/lib/canvas/comments-store";
import { Avatar } from "./Avatar";
import { CommentComposer } from "./CommentComposer";
import { ThreadCard } from "./ThreadCard";

const CARD_W = 288;
const CARD_H = 360;
const MARGIN = 12;

/** Keeps a card inside the surface, flipping to the pin's left or above it when it would spill out. */
function cardStyle(point, size) {
  const left = point.x + 20 + CARD_W > size.w - MARGIN ? Math.max(MARGIN, point.x - 20 - CARD_W) : point.x + 20;
  const top = Math.max(MARGIN, Math.min(point.y - 12, size.h - CARD_H - MARGIN));
  return { left, top };
}

/**
 * Comment pins over the board and the card of the open thread. Pins are placed from the comment data and
 * the viewport, not from the objects on screen, so they stay right while objects are culled. Placing a
 * comment captures the next click on the surface: over an object it attaches to it and moves with it.
 */
export function CommentPins({ boardId, people, currentUserId, canComment, canManage, canMove, size }) {
  const viewport = useCanvasStore((s) => s.history.present.viewport);
  const nodes = useCanvasStore((s) => s.history.present.nodes);
  const comments = useCommentsStore((s) => s.comments);
  const hidden = useCommentsStore((s) => s.hidden);
  const showResolved = useCommentsStore((s) => s.showResolved);
  const placing = useCommentsStore((s) => s.placing);
  const openThreadId = useCommentsStore((s) => s.openThreadId);
  const pinned = useCommentsStore((s) => s.pinned);
  const setPlacing = useCommentsStore((s) => s.setPlacing);
  const openThread = useCommentsStore((s) => s.openThread);
  const post = useCommentsStore((s) => s.post);
  const [draft, setDraft] = useState(null);
  const [color, setColor] = useState(COMMENT_COLORS[0]);
  const [drag, setDrag] = useState(null);
  const dragged = useRef(false);
  const refreshed = useRef(new Set());

  const nodesById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const threads = useMemo(() => {
    const byRoot = new Map();
    for (const comment of comments.values()) {
      if (comment.parentId) byRoot.set(comment.parentId, [...(byRoot.get(comment.parentId) ?? []), comment]);
    }
    const roots = [...comments.values()].filter((comment) => !comment.parentId);
    return roots
      .map((root) => ({ root, replies: (byRoot.get(root.id) ?? []).sort((a, b) => a.createdAt - b.createdAt) }))
      .sort((a, b) => a.root.createdAt - b.root.createdAt);
  }, [comments]);
  const unread = useMemo(() => unreadThreads(comments.values()), [comments]);

  // Keep each thread's stored fallback position at its object's, so deleting the object leaves the pin where it was.
  useEffect(() => {
    const due = driftedAnchors(threads, nodesById).filter(({ id, body }) => {
      const root = comments.get(id);
      return (canMove || String(root?.authorId) === String(currentUserId)) && !refreshed.current.has(`${id}:${body.x}:${body.y}`);
    });
    if (!due.length) return undefined;
    const timer = setTimeout(() => {
      for (const { id, body } of due) {
        refreshed.current.add(`${id}:${body.x}:${body.y}`);
        void useCommentsStore.getState().edit(id, body).catch(() => {});
      }
    }, 1200);
    return () => clearTimeout(timer);
  }, [threads, nodesById, comments, canMove, currentUserId]);

  if (hidden) return null;
  const shown = visibleThreads(threads, { showResolved }).concat(
    openThreadId && !showResolved ? threads.filter(({ root }) => root.id === openThreadId && root.resolvedAt) : []
  );
  const cards = new Set([openThreadId, ...pinned].filter(Boolean));

  const place = (event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const screen = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    const world = screenToWorld(screen, viewport);
    const id = hitTest({ nodes }, world);
    setDraft({ screen, anchor: threadAnchor(world, id ? nodesById.get(id) : null) });
  };
  const startDrag = (event, root) => {
    if (event.button !== 0 || !(canMove || String(root.authorId) === String(currentUserId))) return;
    const rect = event.currentTarget.closest("[data-testid=comment-layer]").getBoundingClientRect();
    const start = { x: event.clientX, y: event.clientY };
    dragged.current = false;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const move = (next) => {
      if (!dragged.current && Math.hypot(next.clientX - start.x, next.clientY - start.y) < 5) return;
      dragged.current = true;
      setDrag({ id: root.id, x: next.clientX - rect.left, y: next.clientY - rect.top });
    };
    const finish = (next) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      setDrag(null);
      if (!dragged.current) return;
      const world = screenToWorld({ x: next.clientX - rect.left, y: next.clientY - rect.top }, viewport);
      const id = hitTest({ nodes }, world);
      void useCommentsStore.getState().edit(root.id, moveAnchor(world, id ? nodesById.get(id) : null)).catch(() => {});
      setTimeout(() => { dragged.current = false; }, 0);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
  };
  const cancelDraft = () => {
    setDraft(null);
    setPlacing(false);
  };

  return (
    <div className="pointer-events-none absolute inset-0 z-20 overflow-hidden" data-testid="comment-layer">
      {placing && !draft && (
        <div
          role="presentation"
          data-testid="comment-capture"
          className="pointer-events-auto absolute inset-0 cursor-crosshair"
          onPointerDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            place(event);
          }}
        />
      )}
      {shown.map(({ root, replies }) => {
        const position = pinPosition(root, nodesById);
        if (!position) return null;
        const point = drag?.id === root.id ? { x: drag.x, y: drag.y } : worldToScreen(position, viewport);
        const onScreen = point.x > -40 && point.y > -40 && point.x < size.w + 40 && point.y < size.h + 40;
        const open = cards.has(root.id);
        if (!onScreen) return null;
        const isUnread = unread.has(root.id);
        return (
          <div key={root.id}>
            <button
              type="button"
              data-pin={root.id}
              aria-label={`Comment thread by ${people.get(root.authorId)?.name ?? "a teammate"}${isUnread ? ", unread" : ""}${root.resolvedAt ? ", resolved" : ""}`}
              onPointerDown={(event) => startDrag(event, root)}
              onClick={(event) => {
                event.stopPropagation();
                if (dragged.current) return;
                openThread(openThreadId === root.id ? null : root.id);
                if (isUnread) void useCommentsStore.getState().markRead({ ids: [root.id, ...replies.map((reply) => reply.id)] });
              }}
              className={cn("pointer-events-auto absolute -translate-x-1/2 -translate-y-full touch-none rounded-full rounded-bl-none p-0.5 shadow-pop transition-opacity", root.resolvedAt && "opacity-50", drag?.id === root.id && "cursor-grabbing")}
              style={{ left: point.x, top: point.y, backgroundColor: root.color || COMMENT_COLORS[0] }}
            >
              <Avatar person={people.get(root.authorId)} userId={root.authorId} size={26} className="ring-0" />
              {replies.length > 0 && <span className="absolute -right-2 -top-1.5 rounded-full bg-ink-900 px-1 text-[10px] font-medium text-white ring-1 ring-line">{replies.length + 1}</span>}
              {isUnread && <span data-unread-dot className="absolute -left-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-mention ring-2 ring-ink-900" />}
            </button>
            {open && (
              <div className="pointer-events-auto absolute" style={cardStyle(point, size)}>
                <ThreadCard thread={{ root, replies }} boardId={boardId} people={people} currentUserId={currentUserId} canComment={canComment} canManage={canManage} onClose={() => (openThreadId === root.id ? openThread(null) : useCommentsStore.getState().togglePinned(root.id))} />
              </div>
            )}
          </div>
        );
      })}
      {draft && (
        <div className="pointer-events-auto absolute w-72 rounded-xl border border-line bg-ink-750 p-2 shadow-pop" style={cardStyle(draft.screen, size)} data-testid="comment-draft">
          <div className="mb-2 flex items-center gap-1.5" role="radiogroup" aria-label="Comment color">
            <MessageSquare className="h-3.5 w-3.5 text-white/50" />
            {COMMENT_COLORS.map((value) => (
              <button key={value} type="button" role="radio" aria-checked={color === value} aria-label={`Color ${value}`} onClick={() => setColor(value)} className={cn("h-4 w-4 rounded-full", color === value && "ring-2 ring-white")} style={{ backgroundColor: value }} />
            ))}
          </div>
          <CommentComposer boardId={boardId} autoFocus submitLabel="Comment" onCancel={cancelDraft} onSubmit={async (body) => { await post({ body, color, ...draft.anchor }); setDraft(null); }} />
        </div>
      )}
    </div>
  );
}
