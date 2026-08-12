"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ChevronDown,
  ChevronsLeft,
  ChevronsRight,
  Layers,
  MessageSquarePlus,
  MoreHorizontal,
  Pencil,
  Trash2,
} from "lucide-react";
import { useStore } from "@/lib/store";
import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Dropdown, MenuItem } from "./Dropdown";
import { ProjectMenu } from "./ProjectMenu";

const COLLAPSE_KEY = "veevee-chat-sidebar-collapsed";

/**
 * Left sidebar for the studio view: which project you're in, and the list
 * of chat threads within it for the current tab (agentKind) — replaces the
 * dropdown-shaped ThreadSwitcher, which didn't leave the thread list visible
 * while you worked. Collapsible, and the collapsed state persists (unlike
 * the assets drawer, this is core workflow state, not a transient panel).
 */
export function ChatSidebar({
  agentKind,
  conversationId,
  onConversationIdChange,
}

) {
  const activeProjectId = useStore((s) => s.activeProjectId);
  const projects = useStore((s) => s.projects);
  const [collapsed, setCollapsed] = useState(false);
  const [conversations, setConversations] = useState([]);
  const [loading, setLoading] = useState(false);
  const [renamingRowId, setRenamingRowId] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const initializedFor = useRef(null);
  const requestIdRef = useRef(0);

  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem(COLLAPSE_KEY) === "1");
    } catch {}
  }, []);

  const toggleCollapsed = () => {
    setCollapsed((c) => {
      const next = !c;
      try {
        localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
      } catch {}
      return next;
    });
  };

  useEffect(() => {
    const scopeKey = activeProjectId ? `${activeProjectId}:${agentKind}` : null;
    if (!scopeKey || initializedFor.current === scopeKey) return;
    initializedFor.current = scopeKey;
    const requestId = ++requestIdRef.current;
    setLoading(true);
    (async () => {
      const res = await fetch(
        `/api/agent-conversations?projectId=${encodeURIComponent(activeProjectId)}&agentKind=${agentKind}`,
        { cache: "no-store" }
      );
      const json = await res.json().catch(() => ({}));
      if (requestIdRef.current !== requestId) return;
      let list = json.conversations ?? [];
      if (list.length === 0) {
        // Lazily create the project's first chat for this tab — same
        // pattern BoardSwitcher.tsx uses for a project's first board.
        // Without this, a project with no threads yet has nothing to
        // select, and the feed below shows "Loading chat…" forever with no
        // way out except manually clicking "+ New chat".
        const created = await apiFetch("/api/agent-conversations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ op: "createConversation", projectId: activeProjectId, agentKind, name: "New chat" }),
        });
        const createdJson = await created.json().catch(() => ({}));
        if (requestIdRef.current !== requestId) return;
        list = createdJson.conversations ?? [];
      }
      setConversations(list);
      setLoading(false);
      if (!conversationId || !list.some((c) => c.id === conversationId)) {
        if (list[0]) onConversationIdChange(list[0].id);
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    })();
  }, [activeProjectId, agentKind]);

  const createConversation = async () => {
    if (!activeProjectId) return;
    const res = await apiFetch("/api/agent-conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op: "createConversation", projectId: activeProjectId, agentKind, name: "New chat" }),
    });
    const json = await res.json().catch(() => ({}));
    if (json.conversations) {
      setConversations(json.conversations);
      if (json.conversation?.id) {
        onConversationIdChange(json.conversation.id);
        setRenamingRowId(json.conversation.id);
      }
    }
  };

  const renameConversation = async (id, name) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setConversations((cs) => cs.map((c) => (c.id === id ? { ...c, name: trimmed } : c)));
    const res = await apiFetch("/api/agent-conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op: "renameConversation", id, name: trimmed }),
    });
    const json = await res.json().catch(() => ({}));
    if (json.conversations) setConversations(json.conversations);
  };

  const deleteConversation = async (id) => {
    const res = await apiFetch("/api/agent-conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op: "deleteConversation", id }),
    });
    const json = await res.json().catch(() => ({}));
    const list = json.conversations ?? conversations.filter((c) => c.id !== id);
    setConversations(list);
    if (conversationId === id && list[0]) onConversationIdChange(list[0].id);
  };

  const project = projects.find((p) => p.id === activeProjectId) ?? null;

  if (collapsed) {
    return (
      <aside className="flex h-full w-11 shrink-0 flex-col items-center gap-2 border-r border-line bg-ink-900 py-2.5">
        <button
          onClick={toggleCollapsed}
          aria-label="Expand chat list"
          title="Expand chat list"
          className="grid h-8 w-8 place-items-center rounded-lg text-white/50 transition hover:bg-white/5 hover:text-white"
        >
          <ChevronsRight className="h-4 w-4" />
        </button>
        <button
          onClick={createConversation}
          aria-label="New chat"
          title="New chat"
          className="grid h-8 w-8 place-items-center rounded-lg text-white/50 transition hover:bg-white/5 hover:text-white"
        >
          <MessageSquarePlus className="h-4 w-4" />
        </button>
      </aside>
    );
  }

  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r border-line bg-ink-900">
      <div className="flex shrink-0 items-center gap-1 border-b border-line p-2">
        <Dropdown
          className="min-w-0 flex-1"
          label="Switch project"
          trigger={(open) => (
            <span
              className={cn(
                "flex min-w-0 items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm text-white/85 transition hover:bg-white/5",
                open && "bg-white/5"
              )}
            >
              <Layers className="h-3.5 w-3.5 shrink-0 text-white/50" />
              <span className="min-w-0 flex-1 truncate text-left">{project ? project.name : "No project"}</span>
              <ChevronDown className={cn("h-3.5 w-3.5 shrink-0 transition-transform", open && "rotate-180")} />
            </span>
          )}
        >
          {(close) => <ProjectMenu close={close} />}
        </Dropdown>
        <button
          onClick={toggleCollapsed}
          aria-label="Collapse chat list"
          title="Collapse chat list"
          className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-white/45 transition hover:bg-white/5 hover:text-white"
        >
          <ChevronsLeft className="h-4 w-4" />
        </button>
      </div>

      <button
        onClick={createConversation}
        disabled={!activeProjectId}
        className="m-2 flex shrink-0 items-center gap-2 rounded-lg border border-dashed border-white/15 px-3 py-2 text-sm text-white/70 transition hover:border-brand/40 hover:text-brand disabled:cursor-not-allowed disabled:opacity-40"
      >
        <MessageSquarePlus className="h-4 w-4" /> New chat
      </button>

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {loading ? (
          <p className="px-2 py-2 text-xs text-white/40">Loading…</p>
        ) : conversations.length === 0 ? (
          <p className="px-2 py-2 text-xs text-white/40">
            {activeProjectId ? "No chats yet." : "Pick a project to start chatting."}
          </p>
        ) : (
          conversations.map((c) =>
            renamingRowId === c.id ? (
              <input
                key={c.id}
                autoFocus
                defaultValue={c.name}
                onFocus={(e) => e.currentTarget.select()}
                onBlur={(e) => {
                  renameConversation(c.id, e.currentTarget.value);
                  setRenamingRowId(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                  if (e.key === "Escape") setRenamingRowId(null);
                }}
                className="mb-0.5 w-full rounded-lg border border-brand/40 bg-ink-800 px-2.5 py-2 text-sm text-white outline-none"
              />
            ) : (
              <div key={c.id} className="group relative">
                <button
                  onClick={() => onConversationIdChange(c.id)}
                  className={cn(
                    "mb-0.5 flex w-full items-center rounded-lg py-2 pl-2.5 pr-8 text-left text-sm transition-colors",
                    c.id === conversationId
                      ? "bg-brand/15 text-white"
                      : "text-white/70 hover:bg-white/5 hover:text-white"
                  )}
                >
                  <span className="truncate">{c.name}</span>
                </button>
                <Dropdown
                  align="right"
                  trigger={(open) => (
                    <span
                      className={cn(
                        "absolute right-1 top-1/2 hidden h-6 w-6 -translate-y-1/2 place-items-center rounded-md text-white/45 hover:bg-white/10 hover:text-white group-hover:grid",
                        open && "grid bg-white/10 text-white"
                      )}
                    >
                      <MoreHorizontal className="h-3.5 w-3.5" />
                    </span>
                  )}
                >
                  {(closeRow) => (
                    <>
                      <MenuItem
                        onClick={() => {
                          setRenamingRowId(c.id);
                          closeRow();
                        }}
                      >
                        <Pencil className="h-4 w-4 text-white/50" /> Rename
                      </MenuItem>
                      <MenuItem
                        onClick={() => {
                          setDeleteTarget(c);
                          closeRow();
                        }}
                      >
                        <Trash2 className="h-4 w-4 text-red-400/80" />
                        <span className="text-red-300/90">Delete</span>
                      </MenuItem>
                    </>
                  )}
                </Dropdown>
              </div>
            )
          )
        )}
      </div>

      {deleteTarget &&
        typeof document !== "undefined" &&
        createPortal(
          <DeleteThreadDialog
            conversation={deleteTarget}
            onCancel={() => setDeleteTarget(null)}
            onConfirm={() => {
              deleteConversation(deleteTarget.id);
              setDeleteTarget(null);
            }}
          />,
          document.body
        )}
    </aside>
  );
}

function DeleteThreadDialog({
  conversation,
  onCancel,
  onConfirm,
}

) {
  const cancelRef = useRef(null);

  useEffect(() => {
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => cancelRef.current?.focus());
    });
    const onKeyDown = (e) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onCancel]);

  return (
    <div className="fixed inset-0 z-[200] grid place-items-center bg-black/50" onClick={onCancel}>
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="delete-thread-title"
        onClick={(e) => e.stopPropagation()}
        className="w-[22rem] rounded-2xl border border-line bg-ink-750 p-5 shadow-pop"
      >
        <h2 id="delete-thread-title" className="text-sm font-semibold text-white">
          Delete this chat?
        </h2>
        <p className="mt-2 text-sm text-white/60">
          “{conversation.name}” will be deleted. This can't be undone.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            className="rounded-lg px-3 py-1.5 text-sm font-medium text-white/70 outline-none hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-brand"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="rounded-lg bg-red-500/80 px-3 py-1.5 text-sm font-semibold text-white outline-none hover:bg-red-500 focus-visible:ring-2 focus-visible:ring-brand"
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}
