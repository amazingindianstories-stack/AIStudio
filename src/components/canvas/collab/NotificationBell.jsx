"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AtSign, Bell, BellRing, CheckCheck, CornerDownRight, Loader2, MessageSquare } from "lucide-react";
import { cn } from "@/lib/utils";
import { displayName } from "@/lib/board-access";
import { formatWhen } from "@/lib/canvas/board-activity";
import { fetchNotifications, markNotificationsRead } from "@/lib/canvas/comments-api";
import { useCommentsStore } from "@/lib/canvas/comments-store";
import { disablePush, enablePush, pushState, pushSupported } from "@/lib/canvas/web-push";
import { usePeople } from "@/lib/canvas/use-people";
import { Avatar } from "./Avatar";

const KIND = {
  mention: { icon: AtSign, text: "mentioned you" },
  reply: { icon: CornerDownRight, text: "replied to a thread you follow" },
  comment: { icon: MessageSquare, text: "commented on a thread you follow" },
};

/**
 * The bell: comments, replies and mentions for the people you work with, newest first. The first tab is every
 * board and there is one tab per board that has activity. Choosing an item opens its thread, switching board first.
 */
export function NotificationBell({ boardId, onOpen }) {
  const people = usePeople();
  const unread = useCommentsStore((s) => s.unread);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState("all");
  const [items, setItems] = useState([]);
  const [boards, setBoards] = useState([]);
  const [next, setNext] = useState(null);
  const [status, setStatus] = useState("idle");
  const [push, setPush] = useState(null);
  const [pushError, setPushError] = useState(null);
  const root = useRef(null);

  const load = useCallback(async (before) => {
    setStatus("loading");
    try {
      const page = await fetchNotifications({ boardId: tab === "all" ? undefined : tab, before, boards: !before });
      setItems((current) => (before ? [...current, ...page.notifications] : page.notifications));
      setNext(page.next);
      if (page.boards) setBoards(page.boards);
      setStatus("ready");
    } catch {
      setStatus("error");
    }
  }, [tab]);

  useEffect(() => {
    if (open) void load();
  }, [open, load, unread]);
  useEffect(() => {
    if (open && pushSupported()) pushState().then(setPush).catch(() => setPush(null));
  }, [open]);
  useEffect(() => {
    if (!open) return undefined;
    const close = (event) => !root.current?.contains(event.target) && setOpen(false);
    const key = (event) => event.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", key);
    };
  }, [open]);

  const readAll = async () => {
    const result = await markNotificationsRead(tab === "all" ? {} : { boardId: tab }).catch(() => null);
    setItems((current) => current.map((item) => ({ ...item, read: true })));
    if (typeof result?.unread === "number") useCommentsStore.setState({ unread: result.unread });
    void load();
  };
  const choose = (item) => {
    setOpen(false);
    if (!item.read) {
      void markNotificationsRead({ ids: [item.id] }).catch(() => {});
      useCommentsStore.setState((state) => ({ unread: Math.max(0, state.unread - 1) }));
    }
    onOpen({ boardId: item.boardId, projectId: item.projectId, commentId: item.threadId ?? item.commentId });
  };
  const togglePush = async () => {
    setPushError(null);
    try {
      if (push?.subscribed) await disablePush();
      else await enablePush();
      setPush(await pushState());
    } catch (error) {
      setPushError(error.message);
    }
  };

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"}
        aria-expanded={open}
        data-testid="notification-bell"
        className={cn("relative grid h-9 w-9 place-items-center rounded-lg text-white/75 hover:bg-white/10 hover:text-white", open && "bg-white/10 text-white")}
      >
        <Bell className="h-[18px] w-[18px]" />
        {unread > 0 && <span data-testid="notification-count" className="absolute right-0.5 top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-mention px-1 text-[10px] font-semibold text-white">{unread > 99 ? "99+" : unread}</span>}
      </button>
      {open && (
        <div role="dialog" aria-label="Notifications" className="absolute right-0 top-full z-40 mt-2 flex max-h-[70vh] w-96 max-w-[calc(100vw-2rem)] flex-col rounded-xl border border-line bg-ink-750 shadow-pop">
          <div role="tablist" aria-label="Notification boards" className="flex items-center gap-1 overflow-x-auto border-b border-line px-2 py-1.5">
            {[{ boardId: "all", name: "All boards", unread: null }, ...boards].map((entry) => (
              <button key={entry.boardId} type="button" role="tab" aria-selected={tab === entry.boardId} onClick={() => setTab(entry.boardId)} className={cn("flex shrink-0 items-center gap-1 rounded-md px-2.5 py-1 text-xs", tab === entry.boardId ? "bg-white/15 text-white" : "text-white/55 hover:bg-white/10")}>
                <span className="max-w-32 truncate">{entry.name}{entry.boardId === boardId ? " (this board)" : ""}</span>
                {entry.unread > 0 && <span className="rounded-full bg-mention px-1 text-[10px] font-semibold text-white">{entry.unread}</span>}
              </button>
            ))}
            <button type="button" onClick={() => void readAll()} className="ml-auto flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs text-white/65 hover:bg-white/10 hover:text-white">
              <CheckCheck className="h-3.5 w-3.5" /> Read all
            </button>
          </div>
          <ul className="min-h-24 flex-1 divide-y divide-line overflow-y-auto">
            {items.map((item) => {
              const Icon = KIND[item.kind]?.icon ?? MessageSquare;
              return (
                <li key={item.id}>
                  <button type="button" onClick={() => choose(item)} data-notification={item.id} className="flex w-full items-start gap-2.5 px-3 py-2.5 text-left hover:bg-white/5">
                    <Avatar person={people.get(item.actorId)} userId={item.actorId} size={28} />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm text-white/90">
                        <span className="font-medium text-white">{displayName(people.get(item.actorId), item.actorId)}</span> {KIND[item.kind]?.text ?? "commented"}
                      </span>
                      {item.snippet && <span className="mt-0.5 line-clamp-2 block text-sm text-white/60">{item.snippet}</span>}
                      <span className="mt-0.5 flex items-center gap-1 text-xs text-white/40"><Icon className="h-3 w-3" />{item.boardName ?? "Deleted board"} - {formatWhen(item.at)}</span>
                    </span>
                    {!item.read && <span aria-label="Unread" className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full bg-mention" />}
                  </button>
                </li>
              );
            })}
            {status === "loading" && <li className="grid place-items-center py-6"><Loader2 className="h-4 w-4 animate-spin text-white/50" /></li>}
            {status === "error" && <li className="px-4 py-6 text-center text-sm text-red-300">Could not load notifications.</li>}
            {status === "ready" && items.length === 0 && <li className="px-4 py-8 text-center text-sm text-white/45">Nothing yet. Mentions, replies and comments on threads you follow show up here.</li>}
            {next && status !== "loading" && (
              <li><button type="button" onClick={() => void load(next)} className="w-full py-2 text-xs text-white/60 hover:bg-white/5 hover:text-white">Show older</button></li>
            )}
          </ul>
          {push && (
            <div className="border-t border-line px-3 py-2 text-xs text-white/60">
              {!push.enabled ? (
                <p>Browser notifications are off because this server has no push keys set.</p>
              ) : push.permission === "denied" ? (
                <p>Browser notifications are blocked. Allow them for this site in the browser settings.</p>
              ) : (
                <label className="flex cursor-pointer items-center gap-2">
                  <BellRing className="h-3.5 w-3.5" />
                  <span className="flex-1">Browser notifications on this device</span>
                  <input type="checkbox" role="switch" checked={push.subscribed} onChange={() => void togglePush()} aria-label="Browser notifications on this device" />
                </label>
              )}
              {pushError && <p role="alert" className="mt-1 text-red-300">{pushError}</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
