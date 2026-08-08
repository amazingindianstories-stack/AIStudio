"use client";

import { useEffect, useRef, useState } from "react";
import { useStore } from "@/lib/store";
import { ThreadSwitcher } from "./ThreadSwitcher";
import { OrchestratorChat } from "./OrchestratorChat";
import { ConversationPanel } from "./ConversationPanel";

/**
 * Wraps the center column's thread selection: a ThreadSwitcher above, then
 * either the unmodified ConversationPanel (today's generation-history feed,
 * for the pinned "Old"/legacy thread) or the new OrchestratorChat (any real
 * chat thread). conversationId is local state — mirrors how CanvasView holds
 * boardId locally rather than in a global store — reset whenever the active
 * project changes so a stale thread from a different project is never shown.
 */
export function ChatColumn() {
  const activeProjectId = useStore((s) => s.activeProjectId);
  const setPrompt = useStore((s) => s.setPrompt);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [conversationKind, setConversationKind] = useState<"chat" | "legacy">("legacy");
  const lastProjectId = useRef<string | null>(null);

  useEffect(() => {
    if (activeProjectId !== lastProjectId.current) {
      lastProjectId.current = activeProjectId;
      setConversationId(null);
    }
  }, [activeProjectId]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center border-b border-line px-4 py-2 sm:px-8">
        <ThreadSwitcher
          projectId={activeProjectId}
          conversationId={conversationId}
          onConversationIdChange={(id, kind) => {
            setConversationId(id);
            setConversationKind(kind);
          }}
        />
      </div>

      {conversationId && conversationKind === "chat" ? (
        <OrchestratorChat conversationId={conversationId} onUsePrompt={setPrompt} />
      ) : (
        <ConversationPanel />
      )}
    </div>
  );
}
