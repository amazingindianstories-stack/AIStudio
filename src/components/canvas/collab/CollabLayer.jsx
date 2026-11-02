"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Eye, EyeOff, MessageSquare, MessageSquarePlus } from "lucide-react";
import { cn } from "@/lib/utils";
import { useStore } from "@/lib/store";
import { useCanvasStore } from "@/lib/canvas-store";
import { canCommentRole, canEditRole, canShareRole } from "@/lib/board-access";
import { pinPosition, unreadThreads } from "@/lib/canvas/comments";
import { useCommentsStore } from "@/lib/canvas/comments-store";
import { useBoardPolling } from "@/lib/canvas/use-board-polling";
import { usePeople } from "@/lib/canvas/use-people";
import { CommentPins } from "./CommentPins";
import { CommentsPanel } from "./CommentsPanel";
import { NotificationBell } from "./NotificationBell";
import { PeopleBar } from "./PeopleBar";

const editable = (target) => target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));

/**
 * Everything collaborative on an open board, mounted once from CanvasView: comment pins and threads, the
 * comments panel, the people bar and the notification bell, all fed by one poll beside the board version poll.
 * `commentLink` ({ boardId, commentId }) is a thread to open once its board is loaded; `onCommentLinkDone` drops it.
 */
export function CollabLayer({ boardId, commentLink, onCommentLinkDone, insetRight = 16, insetTop }) {
  const people = usePeople();
  const currentUser = useStore((s) => s.currentUser);
  const openBoardLink = useStore((s) => s.openBoardLink);
  const boardRole = useCanvasStore((s) => s.boardRole);
  const loadedBoardId = useCanvasStore((s) => s.boardId);
  const ready = Boolean(boardId) && loadedBoardId === boardId;
  const status = useCommentsStore((s) => s.status);
  const placing = useCommentsStore((s) => s.placing);
  const hidden = useCommentsStore((s) => s.hidden);
  const panelOpen = useCommentsStore((s) => s.panelOpen);
  const comments = useCommentsStore((s) => s.comments);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const box = useRef(null);
  const hasBoard = Boolean(boardId);
  const canComment = canCommentRole(boardRole);
  const unreadCount = unreadThreads(comments.values()).size;

  useEffect(() => {
    if (!ready) return undefined;
    void useCommentsStore.getState().open(boardId);
    return () => useCommentsStore.getState().close();
  }, [boardId, ready]);

  const pulse = useCallback(() => useCommentsStore.getState().pulse(), []);
  useBoardPolling(ready ? boardId : null, pulse);

  useEffect(() => {
    const element = box.current;
    if (!element) return undefined;
    const observer = new ResizeObserver(() => setSize({ w: element.clientWidth, h: element.clientHeight }));
    setSize({ w: element.clientWidth, h: element.clientHeight });
    observer.observe(element);
    return () => observer.disconnect();
  }, [hasBoard]);

  // Shift+M starts a comment (plain M is the minimap, C the connector tool); Escape leaves placing.
  useEffect(() => {
    const onKey = (event) => {
      if (editable(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
      const { placing: on, setPlacing, hidden: off } = useCommentsStore.getState();
      if (event.shiftKey && event.key.toLowerCase() === "m" && canComment && ready && !off) {
        event.preventDefault();
        setPlacing(!on);
      } else if (event.key === "Escape" && on) setPlacing(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [canComment, ready]);

  // Open the thread a notification or link asked for once its board and comments are loaded.
  const openThreadFor = useCallback((commentId) => {
    const { comments: all, openThread } = useCommentsStore.getState();
    const root = all.get(commentId);
    const top = root?.parentId ? all.get(root.parentId) : root;
    if (!top) return;
    const present = useCanvasStore.getState().history.present;
    const position = pinPosition(top, new Map(present.nodes.map((node) => [node.id, node])));
    if (position) {
      const store = useCanvasStore.getState();
      const size = store.viewportSize();
      store.setViewport({ x: position.x - size.w / 2 / present.viewport.zoom, y: position.y - size.h / 2 / present.viewport.zoom, zoom: present.viewport.zoom });
    }
    useCommentsStore.getState().setHidden(false);
    openThread(top.id);
  }, []);
  useEffect(() => {
    if (!commentLink || commentLink.boardId !== boardId || !ready || status !== "ready") return;
    openThreadFor(commentLink.commentId);
    onCommentLinkDone();
  }, [commentLink, boardId, ready, status, openThreadFor, onCommentLinkDone]);

  if (!boardId) return null;
  const button = "grid h-9 w-9 place-items-center rounded-lg text-white/75 hover:bg-white/10 hover:text-white";
  return (
    <div ref={box} className="pointer-events-none absolute inset-0 z-20">
      {ready && size.w > 0 && (
        <CommentPins boardId={boardId} people={people} currentUserId={currentUser?.id} canComment={canComment} canManage={canShareRole(boardRole)} canMove={canEditRole(boardRole)} size={size} />
      )}
      {ready && panelOpen && <CommentsPanel people={people} onClose={() => useCommentsStore.getState().setPanelOpen(false)} />}
      <div className="pointer-events-auto absolute top-16 z-30 flex items-center gap-1 rounded-xl border border-line bg-ink-800/95 p-1 shadow-panel" style={{ right: insetRight, ...(insetTop ? { top: insetTop } : {}) }}>
        <PeopleBar people={people} currentUserId={currentUser?.id} />
        {canComment && (
          <button type="button" onClick={() => useCommentsStore.getState().setPlacing(!placing)} disabled={hidden} aria-label="Add comment" aria-pressed={placing} title="Add comment (Shift+M)" data-testid="add-comment" className={cn(button, placing && "bg-white/15 text-white", hidden && "opacity-40")}>
            <MessageSquarePlus className="h-[18px] w-[18px]" />
          </button>
        )}
        <button type="button" onClick={() => useCommentsStore.getState().setPanelOpen(!panelOpen)} aria-label={unreadCount ? `Comments, ${unreadCount} unread` : "Comments"} aria-pressed={panelOpen} title="Comments" data-testid="comments-panel-toggle" className={cn(button, "relative", panelOpen && "bg-white/15 text-white")}>
          <MessageSquare className="h-[18px] w-[18px]" />
          {unreadCount > 0 && <span className="absolute right-1 top-1 h-2.5 w-2.5 rounded-full bg-mention ring-2 ring-ink-800" />}
        </button>
        <button type="button" onClick={() => useCommentsStore.getState().setHidden(!hidden)} aria-label={hidden ? "Show comments on the board" : "Hide comments on the board"} aria-pressed={hidden} title={hidden ? "Show comments" : "Hide comments"} data-testid="toggle-comments-visibility" className={button}>
          {hidden ? <EyeOff className="h-[18px] w-[18px]" /> : <Eye className="h-[18px] w-[18px]" />}
        </button>
        <NotificationBell boardId={boardId} onOpen={openBoardLink} />
      </div>
    </div>
  );
}
