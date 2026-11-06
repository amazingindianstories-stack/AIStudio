"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, FolderClosed } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useStore } from "@/lib/store";
import { modeAvailable } from "@/lib/config";
import { CHAT_MODES } from "@/lib/agent-composer";
import { cn } from "@/lib/utils";
import { ChatSidebar } from "./ChatSidebar";
import { DestinationPicker, destinationOf } from "./ComposerControls";
import { StudioChat } from "./StudioChat";

/**
 * The Agents tab: the project's chat list beside one chat, under a header that says where you are (the project and
 * the open chat) and where new work lands (the active folder, which the generation destination menu changes). The
 * chat's own mode tabs switch between Image, Video and Upscale inside the same thread.
 *
 * Owns `conversationId` and hands it to both ChatSidebar (the thread list + selection) and StudioChat (the feed), so
 * the two can't disagree about which thread is open.
 */
export function StudioView() {
  const mode = useStore((s) => s.mode);
  const setMode = useStore((s) => s.setMode);
  const availableModelIds = useStore((s) => s.availableModelIds);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const [conversationId, setConversationId] = useState(null);
  const [conversations, setConversations] = useState([]);
  const projectRef = useRef(undefined);

  // A thread belongs to its project: a project switch must never leave the previous project's chat open.
  useEffect(() => {
    if (projectRef.current === activeProjectId) return;
    projectRef.current = activeProjectId;
    setConversationId(null);
  }, [activeProjectId]);

  // The chat works in Image, Video or Upscale; arriving from Depth (or with every upscaler off) starts in Image.
  useEffect(() => {
    if (!CHAT_MODES.includes(mode) || (mode === "upscale" && !modeAvailable("upscale", availableModelIds))) setMode("image");
  }, [mode, availableModelIds, setMode]);

  const conversation = conversations.find((c) => c.id === conversationId) ?? null;

  return (
    <div className="relative flex min-h-0 flex-1">
      <ChatSidebar
        conversationId={conversationId}
        onConversationIdChange={setConversationId}
        onConversationsChange={setConversations}
      />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <AgentsHeader chatName={conversation?.name} />
        <StudioChat conversationId={conversationId} />
      </div>
    </div>
  );
}

function AgentsHeader({ chatName }) {
  const location = useStore(useShallow(destinationOf));
  const projectName = location.project ? location.project.name : "Global Library";
  const folderName = location.folder ? location.folder.name : "Unsorted";

  return (
    <header
      data-testid="agents-header"
      className="flex h-12 shrink-0 items-center gap-3 border-b border-line px-3 sm:px-5"
    >
      <div className="flex min-w-0 flex-1 items-center gap-2.5">
        <h1 className="hidden shrink-0 text-sm font-semibold text-white sm:block">Agents</h1>
        <span aria-hidden="true" className="hidden h-4 w-px shrink-0 bg-line sm:block" />
        <nav aria-label="Location" className="min-w-0 flex-1">
          <ol className="flex min-w-0 items-center gap-1 text-sm">
            <li className="min-w-0 max-w-[45%] shrink truncate text-white/50" title={projectName}>{projectName}</li>
            <li aria-hidden="true" className="shrink-0 text-white/25"><ChevronRight className="h-3.5 w-3.5" /></li>
            <li
              aria-current="page"
              data-testid="agents-chat-name"
              className="min-w-0 flex-1 truncate font-medium text-white/90"
              title={chatName || undefined}
            >
              {chatName || "Chat"}
            </li>
          </ol>
        </nav>
      </div>
      <DestinationPicker
        className="shrink-0"
        side="bottom"
        trigger={(open) => (
          <span
            data-testid="agents-destination"
            title={`New work saves to ${projectName} / ${folderName}`}
            className={cn(
              "flex max-w-[11rem] items-center gap-1.5 rounded-full border border-line bg-ink-800 px-2.5 py-1 text-xs text-white/80 transition hover:border-lineStrong hover:text-white sm:max-w-[16rem]",
              open && "border-brand/40 text-white"
            )}
          >
            <FolderClosed className="h-3.5 w-3.5 shrink-0 text-white/50" />
            <span className="hidden shrink-0 text-white/45 sm:inline">Saving to</span>
            <span className="min-w-0 truncate font-medium">{folderName}</span>
            <ChevronDown className={cn("h-3 w-3 shrink-0 text-white/45 transition-transform", open && "rotate-180")} />
          </span>
        )}
      />
    </header>
  );
}
