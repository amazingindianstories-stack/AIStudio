"use client";

import { useEffect, useRef, useState } from "react";
import { useStore } from "@/lib/store";
import { ChatSidebar } from "./ChatSidebar";
import { StudioChat } from "./StudioChat";

/**
 * Owns `conversationId` for the Image/Video tabs and hands it to both
 * ChatSidebar (the thread list + selection) and StudioChat (the feed) —
 * lifted out of StudioChat itself so the two can't disagree about which
 * thread is open.
 */
export function StudioView() {
  const mode = useStore((s) => s.mode);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const scopeRef = useRef<string | null>(null);

  // Reset whenever the project or tab changes — a stale thread from a
  // different project/mode must never be shown (mirrors CanvasView holding
  // boardId locally and resetting it the same way).
  useEffect(() => {
    const scope = `${activeProjectId}:${mode}`;
    if (scope !== scopeRef.current) {
      scopeRef.current = scope;
      setConversationId(null);
    }
  }, [activeProjectId, mode]);

  return (
    <div className="flex min-h-0 flex-1">
      <ChatSidebar agentKind={mode} conversationId={conversationId} onConversationIdChange={setConversationId} />
      <StudioChat conversationId={conversationId} />
    </div>
  );
}
