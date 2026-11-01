"use client";

import { useMemo, useState } from "react";
import { CheckCheck, MessageSquare, Pin, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { displayName } from "@/lib/board-access";
import { formatWhen } from "@/lib/canvas/board-activity";
import { useCanvasStore } from "@/lib/canvas-store";
import { pinPosition, plainBody, threadsOf, unreadThreads } from "@/lib/canvas/comments";
import { useCommentsStore } from "@/lib/canvas/comments-store";
import { Avatar } from "./Avatar";

const FILTERS = [
  { id: "open", label: "Open" },
  { id: "unread", label: "Unread" },
  { id: "resolved", label: "Resolved" },
];

/** Every thread on the board, newest first: open, unread or resolved. Choosing one brings its pin into view and opens it. */
export function CommentsPanel({ people, onClose }) {
  const comments = useCommentsStore((s) => s.comments);
  const pinned = useCommentsStore((s) => s.pinned);
  const status = useCommentsStore((s) => s.status);
  const openThread = useCommentsStore((s) => s.openThread);
  const markRead = useCommentsStore((s) => s.markRead);
  const [filter, setFilter] = useState("open");

  const unread = useMemo(() => unreadThreads(comments.values()), [comments]);
  const rows = useMemo(() => {
    const all = threadsOf(comments.values()).reverse();
    const chosen = all.filter(({ root }) => (filter === "resolved" ? root.resolvedAt : filter === "unread" ? !root.resolvedAt && unread.has(root.id) : !root.resolvedAt));
    return [...chosen.filter(({ root }) => pinned.includes(root.id)), ...chosen.filter(({ root }) => !pinned.includes(root.id))];
  }, [comments, filter, pinned, unread]);

  const jump = ({ root, replies }) => {
    const store = useCanvasStore.getState();
    const present = store.history.present;
    const nodesById = new Map(present.nodes.map((node) => [node.id, node]));
    const position = pinPosition(root, nodesById);
    if (position) {
      const { zoom } = present.viewport;
      const size = store.viewportSize();
      store.setViewport({ x: position.x - size.w / 2 / zoom, y: position.y - size.h / 2 / zoom, zoom });
    }
    openThread(root.id);
    if (unread.has(root.id)) void markRead({ ids: [root.id, ...replies.map((reply) => reply.id)] });
  };

  return (
    <aside aria-label="Comments" className="pointer-events-auto absolute bottom-20 right-4 top-28 z-30 flex w-80 max-w-[calc(100%-2rem)] flex-col rounded-xl border border-line bg-ink-750 shadow-pop">
      <header className="flex items-center gap-2 border-b border-line px-3 py-2">
        <MessageSquare className="h-4 w-4 text-white/60" />
        <h2 className="text-sm font-medium text-white">Comments</h2>
        <button type="button" onClick={() => void markRead()} disabled={unread.size === 0} className="ml-auto inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-white/65 hover:bg-white/10 hover:text-white disabled:opacity-35">
          <CheckCheck className="h-3.5 w-3.5" /> Mark all read
        </button>
        <button type="button" onClick={onClose} aria-label="Close comments" className="rounded p-1 text-white/60 hover:bg-white/10 hover:text-white">
          <X className="h-4 w-4" />
        </button>
      </header>
      <div role="tablist" aria-label="Comment filter" className="flex gap-1 border-b border-line px-2 py-1.5">
        {FILTERS.map((item) => (
          <button key={item.id} type="button" role="tab" aria-selected={filter === item.id} onClick={() => setFilter(item.id)} className={cn("rounded-md px-2.5 py-1 text-xs", filter === item.id ? "bg-white/15 text-white" : "text-white/55 hover:bg-white/10")}>
            {item.label}
            {item.id === "unread" && unread.size > 0 ? ` ${unread.size}` : ""}
          </button>
        ))}
      </div>
      <ul className="min-h-0 flex-1 divide-y divide-line overflow-y-auto">
        {rows.map((thread) => {
          const { root, replies } = thread;
          const last = replies[replies.length - 1] ?? root;
          return (
            <li key={root.id}>
              <button type="button" onClick={() => jump(thread)} data-panel-thread={root.id} className="flex w-full items-start gap-2 px-3 py-2.5 text-left hover:bg-white/5">
                <Avatar person={people.get(root.authorId)} userId={root.authorId} size={24} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-sm font-medium text-white">{displayName(people.get(root.authorId), root.authorId)}</span>
                    {pinned.includes(root.id) && <Pin className="h-3 w-3 text-white/45" aria-label="Pinned" />}
                    <span className="ml-auto shrink-0 text-xs text-white/40">{formatWhen(last.createdAt)}</span>
                  </span>
                  <span className="mt-0.5 line-clamp-2 block text-sm text-white/70">{plainBody(root.body)}</span>
                  {replies.length > 0 && <span className="mt-0.5 block text-xs text-white/40">{replies.length} {replies.length === 1 ? "reply" : "replies"}</span>}
                </span>
                {unread.has(root.id) && <span aria-label="Unread" className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full bg-mention" />}
              </button>
            </li>
          );
        })}
        {rows.length === 0 && (
          <li className="px-4 py-8 text-center text-sm text-white/45">
            {status === "loading" ? "Loading comments" : filter === "unread" ? "You are all caught up." : filter === "resolved" ? "No resolved threads." : "No comments yet. Press M or use the comment button to start one."}
          </li>
        )}
      </ul>
    </aside>
  );
}
