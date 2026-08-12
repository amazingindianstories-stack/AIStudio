"use client";

import { useEffect, useRef, useState } from "react";
import { Image as ImageIcon, Clapperboard } from "lucide-react";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { ChatSidebar } from "./ChatSidebar";
import { StudioChat } from "./StudioChat";

/**
 * Owns `conversationId` for the orchestrator chat and hands it to both
 * ChatSidebar (the thread list + selection) and StudioChat (the feed) —
 * lifted out of StudioChat itself so the two can't disagree about which
 * thread is open.
 *
 * Mounted under the standalone admin-only Agents tab (page.tsx), not as the
 * Image/Video tabs themselves — so unlike the design this was ported from,
 * there's no outer nav button that sets the global `mode` between image and
 * video. This in-panel toggle is what does that here instead; it's the only
 * addition StudioView needed for that relocation.
 */
export function StudioView() {
  const mode = useStore((s) => s.mode);
  const setMode = useStore((s) => s.setMode);
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
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-line px-3 py-2">
        {(
          [
            { id: "image" as const, icon: ImageIcon, label: "Image agent" },
            { id: "video" as const, icon: Clapperboard, label: "Video agent" },
          ]
        ).map((t) => (
          <button
            key={t.id}
            onClick={() => setMode(t.id)}
            className={cn(
              "flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium transition-colors",
              mode === t.id
                ? "bg-white/10 text-white"
                : "text-white/50 hover:bg-white/5 hover:text-white/90"
            )}
          >
            <t.icon className="h-3.5 w-3.5" strokeWidth={1.9} />
            {t.label}
          </button>
        ))}
      </div>
      <div className="flex min-h-0 flex-1">
        <ChatSidebar agentKind={mode} conversationId={conversationId} onConversationIdChange={setConversationId} />
        <StudioChat conversationId={conversationId} />
      </div>
    </div>
  );
}
