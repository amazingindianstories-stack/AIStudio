"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Plus, Pencil, Trash2, Check, MoreHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";
import { Dropdown, MenuItem } from "@/components/Dropdown";
import type { AgentConversationMeta, AgentKind } from "@/lib/agents/orchestrator/types";

/**
 * Chat-thread dropdown for StudioChat — list/create/rename/switch, adapted
 * from BoardSwitcher.tsx (canvas board equivalent). Scoped by `agentKind`:
 * the Image tab and Video tab each see only their own threads (separate
 * lists, same as separate boards per project).
 */
export function ThreadSwitcher({
  projectId,
  agentKind,
  conversationId,
  onConversationIdChange,
}: {
  projectId: string | null;
  agentKind: AgentKind;
  conversationId: string | null;
  onConversationIdChange: (id: string) => void;
}) {
  const [conversations, setConversations] = useState<AgentConversationMeta[]>([]);
  const [loading, setLoading] = useState(false);
  const [renamingTrigger, setRenamingTrigger] = useState(false);
  const [renamingRowId, setRenamingRowId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AgentConversationMeta | null>(null);
  const initializedFor = useRef<string | null>(null);
  const requestIdRef = useRef(0);

  useEffect(() => {
    const scopeKey = projectId ? `${projectId}:${agentKind}` : null;
    if (!scopeKey || initializedFor.current === scopeKey) return;
    initializedFor.current = scopeKey;
    const requestId = ++requestIdRef.current;
    setLoading(true);
    (async () => {
      const res = await fetch(
        `/api/agent-conversations?projectId=${encodeURIComponent(projectId!)}&agentKind=${agentKind}`,
        { cache: "no-store" }
      );
      const json = await res.json().catch(() => ({}));
      if (requestIdRef.current !== requestId) return; // superseded by a newer switch
      const list: AgentConversationMeta[] = json.conversations ?? [];
      setConversations(list);
      setLoading(false);
      if (!conversationId || !list.some((c) => c.id === conversationId)) {
        if (list[0]) onConversationIdChange(list[0].id);
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    })();
  }, [projectId, agentKind]);

  const current = conversations.find((c) => c.id === conversationId) ?? null;

  const createConversation = async () => {
    if (!projectId) return;
    const res = await fetch("/api/agent-conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op: "createConversation", projectId, agentKind, name: "New chat" }),
    });
    const json = await res.json().catch(() => ({}));
    if (json.conversations) {
      setConversations(json.conversations);
      if (json.conversation?.id) {
        onConversationIdChange(json.conversation.id);
        setRenamingTrigger(true);
      }
    }
  };

  const renameConversation = async (id: string, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setConversations((cs) => cs.map((c) => (c.id === id ? { ...c, name: trimmed } : c)));
    const res = await fetch("/api/agent-conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op: "renameConversation", id, name: trimmed }),
    });
    const json = await res.json().catch(() => ({}));
    if (json.conversations) setConversations(json.conversations);
  };

  const deleteConversation = async (id: string) => {
    const res = await fetch("/api/agent-conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op: "deleteConversation", id }),
    });
    const json = await res.json().catch(() => ({}));
    const list: AgentConversationMeta[] = json.conversations ?? conversations.filter((c) => c.id !== id);
    setConversations(list);
    if (conversationId === id && list[0]) {
      onConversationIdChange(list[0].id);
    }
  };

  return (
    <>
      {renamingTrigger ? (
        <input
          autoFocus
          defaultValue={current?.name ?? "New chat"}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={(e) => {
            if (conversationId) renameConversation(conversationId, e.currentTarget.value);
            setRenamingTrigger(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") setRenamingTrigger(false);
          }}
          className="rounded-full border border-brand/40 bg-ink-700 px-3 py-1.5 text-sm text-white outline-none"
        />
      ) : (
        <Dropdown
          label="Switch chat"
          trigger={(open) => (
            <span
              className={cn(
                "flex max-w-[220px] items-center gap-1.5 rounded-full border border-line bg-ink-700 pl-3 pr-2 py-1.5 text-sm text-white/85 transition hover:text-white",
                open && "border-brand/40"
              )}
            >
              <span className="truncate">{loading ? "Loading chats…" : current?.name ?? "Chat"}</span>
              <ChevronDown className={cn("h-3.5 w-3.5 shrink-0 transition-transform", open && "rotate-180")} />
            </span>
          )}
        >
          {(close) => (
            <div className="w-60">
              {conversations.map((c) =>
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
                  <div key={c.id} className="group flex items-center">
                    <MenuItem
                      active={c.id === conversationId}
                      onClick={() => {
                        onConversationIdChange(c.id);
                        close();
                      }}
                    >
                      <span className="flex-1 truncate">{c.name}</span>
                      {c.id === conversationId && <Check className="h-4 w-4 shrink-0 text-brand" />}
                    </MenuItem>
                    <Dropdown
                      align="right"
                      trigger={(open) => (
                        <span
                          className={cn(
                            "ml-0.5 hidden h-7 w-7 shrink-0 place-items-center rounded-lg text-white/45 hover:bg-white/10 hover:text-white group-hover:grid",
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
                              close();
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
              )}
              <div className="my-1 h-px bg-line" />
              <MenuItem
                onClick={() => {
                  createConversation();
                  close();
                }}
              >
                <Plus className="h-4 w-4 text-white/60" /> New chat
              </MenuItem>
            </div>
          )}
        </Dropdown>
      )}

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
    </>
  );
}

function DeleteThreadDialog({
  conversation,
  onCancel,
  onConfirm,
}: {
  conversation: AgentConversationMeta;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => cancelRef.current?.focus());
    });
    const onKeyDown = (e: KeyboardEvent) => {
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
