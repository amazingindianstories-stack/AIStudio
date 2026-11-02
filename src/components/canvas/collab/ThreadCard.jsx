"use client";

import { useState } from "react";
import { Bell, BellOff, Check, MailOpen, MoreHorizontal, Pencil, Pin, PinOff, SmilePlus, Trash2, Undo2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { displayName } from "@/lib/board-access";
import { formatWhen } from "@/lib/canvas/board-activity";
import { COMMENT_EMOJIS } from "@/lib/canvas/comments";
import { useCommentsStore } from "@/lib/canvas/comments-store";
import { Avatar } from "./Avatar";
import { CommentBody } from "./CommentBody";
import { CommentComposer } from "./CommentComposer";

function Reactions({ comment, currentUserId, canReact }) {
  const react = useCommentsStore((s) => s.react);
  const [picking, setPicking] = useState(false);
  const entries = Object.entries(comment.reactions ?? {}).filter(([, users]) => users.length);
  const toggle = (emoji) => {
    setPicking(false);
    void react(comment.id, emoji).catch(() => {});
  };
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1">
      {entries.map(([emoji, users]) => {
        const mine = users.includes(String(currentUserId));
        return (
          <button
            key={emoji}
            type="button"
            disabled={!canReact}
            onClick={() => toggle(emoji)}
            aria-pressed={mine}
            aria-label={`${emoji} ${users.length}`}
            className={cn("rounded-full border px-1.5 py-0.5 text-xs", mine ? "border-mention/60 bg-mention/20 text-white" : "border-line text-white/70 hover:bg-white/10")}
          >
            {emoji} {users.length}
          </button>
        );
      })}
      {canReact && (
        <span className="relative">
          <button type="button" onClick={() => setPicking((open) => !open)} aria-label="Add reaction" aria-expanded={picking} className="rounded-full p-1 text-white/45 hover:bg-white/10 hover:text-white">
            <SmilePlus className="h-3.5 w-3.5" />
          </button>
          {picking && (
            <div role="menu" aria-label="Reactions" className="absolute bottom-full left-0 z-10 mb-1 grid w-40 grid-cols-6 gap-0.5 rounded-lg border border-line bg-ink-750 p-1 shadow-pop">
              {COMMENT_EMOJIS.map((emoji) => (
                <button key={emoji} type="button" role="menuitem" onClick={() => toggle(emoji)} className="rounded p-1 text-base hover:bg-white/10">
                  {emoji}
                </button>
              ))}
            </div>
          )}
        </span>
      )}
    </div>
  );
}

function Entry({ comment, person, currentUserId, canModify, canReact, boardId, root }) {
  const edit = useCommentsStore((s) => s.edit);
  const remove = useCommentsStore((s) => s.remove);
  const [editing, setEditing] = useState(false);
  return (
    <div className={cn("group py-2", !comment.read && "border-l-2 border-mention pl-2")} data-comment={comment.id} data-unread={!comment.read}>
      <div className="flex items-center gap-2">
        <Avatar person={person} userId={comment.authorId} size={22} />
        <span className="truncate text-sm font-medium text-white">{displayName(person, comment.authorId)}</span>
        <span className="shrink-0 text-xs text-white/40">{formatWhen(comment.createdAt)}{comment.editedAt ? " (edited)" : ""}</span>
        {canModify && !editing && (
          <span className="ml-auto flex opacity-0 focus-within:opacity-100 group-hover:opacity-100">
            {String(comment.authorId) === String(currentUserId) && (
              <button type="button" onClick={() => setEditing(true)} aria-label="Edit comment" className="rounded p-1 text-white/50 hover:bg-white/10 hover:text-white">
                <Pencil className="h-3.5 w-3.5" />
              </button>
            )}
            <button type="button" onClick={() => void remove(comment.id).catch(() => {})} aria-label={root ? "Delete thread" : "Delete comment"} className="rounded p-1 text-white/50 hover:bg-white/10 hover:text-red-300">
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </span>
        )}
      </div>
      {editing ? (
        <div className="mt-1">
          <CommentComposer boardId={boardId} initial={comment.body} autoFocus submitLabel="Save" onCancel={() => setEditing(false)} onSubmit={async (body) => { await edit(comment.id, { body }); setEditing(false); }} />
        </div>
      ) : (
        <CommentBody body={comment.body} currentUserId={currentUserId} className="mt-1" />
      )}
      <Reactions comment={comment} currentUserId={currentUserId} canReact={canReact} />
    </div>
  );
}

/**
 * One comment thread: the first comment, its replies, reactions, and the thread's own actions (resolve,
 * pin, follow, mark unread). A comment's author edits it; its author and board sharers delete it.
 */
export function ThreadCard({ thread, boardId, people, currentUserId, canComment, canManage, onClose, className }) {
  const { root, replies } = thread;
  const post = useCommentsStore((s) => s.post);
  const resolve = useCommentsStore((s) => s.resolve);
  const markRead = useCommentsStore((s) => s.markRead);
  const follow = useCommentsStore((s) => s.follow);
  const togglePinned = useCommentsStore((s) => s.togglePinned);
  const pinned = useCommentsStore((s) => s.pinned.includes(root.id));
  const following = useCommentsStore((s) => s.follows.all || s.follows.threads.includes(root.id));
  const [menu, setMenu] = useState(false);
  const resolved = Boolean(root.resolvedAt);
  const all = [root, ...replies];
  const modify = (comment) => canComment && (String(comment.authorId) === String(currentUserId) || canManage);

  return (
    <section aria-label="Comment thread" data-thread={root.id} className={cn("flex max-h-[min(70vh,520px)] w-72 flex-col rounded-xl border border-line bg-ink-750 shadow-pop", className)}>
      <header className="flex items-center gap-1 border-b border-line px-2 py-1.5">
        <span className="px-1 text-xs font-medium text-white/60">{resolved ? "Resolved" : "Thread"}</span>
        <span className="ml-auto flex items-center">
          {canComment && (
            <button type="button" onClick={() => void resolve(root.id, !resolved).catch(() => {})} aria-label={resolved ? "Reopen thread" : "Resolve thread"} title={resolved ? "Reopen" : "Resolve"} className="rounded p-1.5 text-white/60 hover:bg-white/10 hover:text-white">
              {resolved ? <Undo2 className="h-4 w-4" /> : <Check className="h-4 w-4" />}
            </button>
          )}
          <span className="relative">
            <button type="button" onClick={() => setMenu((open) => !open)} aria-label="Thread options" aria-expanded={menu} className="rounded p-1.5 text-white/60 hover:bg-white/10 hover:text-white">
              <MoreHorizontal className="h-4 w-4" />
            </button>
            {menu && (
              <div role="menu" className="absolute right-0 top-full z-10 mt-1 w-44 rounded-lg border border-line bg-ink-750 py-1 shadow-pop">
                <MenuRow icon={pinned ? PinOff : Pin} onClick={() => { togglePinned(root.id); setMenu(false); }}>{pinned ? "Unpin thread" : "Pin thread"}</MenuRow>
                <MenuRow icon={following ? BellOff : Bell} onClick={() => { void follow(root.id, !following); setMenu(false); }}>{following ? "Unfollow thread" : "Follow thread"}</MenuRow>
                <MenuRow icon={MailOpen} onClick={() => { void markRead({ ids: [root.id, ...replies.map((reply) => reply.id)], unread: true }); setMenu(false); onClose?.(); }}>Mark as unread</MenuRow>
              </div>
            )}
          </span>
          {onClose && (
            <button type="button" onClick={onClose} aria-label="Close thread" className="rounded p-1.5 text-white/60 hover:bg-white/10 hover:text-white">
              <X className="h-4 w-4" />
            </button>
          )}
        </span>
      </header>
      <div className="min-h-0 flex-1 divide-y divide-line overflow-y-auto px-3">
        {all.map((comment, index) => (
          <Entry key={comment.id} comment={comment} root={index === 0} boardId={boardId} person={people.get(comment.authorId)} currentUserId={currentUserId} canModify={modify(comment)} canReact={canComment} />
        ))}
      </div>
      {canComment ? (
        <div className="border-t border-line p-2">
          <CommentComposer boardId={boardId} threadId={root.id} placeholder="Reply, @ to mention" submitLabel="Reply" onSubmit={(body) => post({ body, parentId: root.id })} />
        </div>
      ) : (
        <p className="border-t border-line px-3 py-2 text-xs text-white/45">You can read this thread but not reply.</p>
      )}
    </section>
  );
}

function MenuRow({ icon: Icon, onClick, children }) {
  return (
    <button type="button" role="menuitem" onClick={onClick} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-white/85 hover:bg-white/10">
      <Icon className="h-4 w-4 text-white/55" /> {children}
    </button>
  );
}
