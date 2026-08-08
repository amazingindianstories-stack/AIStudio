"use client";

import { useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  ImagePlus,
  Loader2,
  Send,
  Sparkles,
  Wand2,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { encodeBlobWithBudget } from "@/lib/client-image-budget";
import type { AgentConversationMessage } from "@/lib/agents/orchestrator/types";

const MAX_IMAGES = 4;

interface DisplayMessage extends AgentConversationMessage {
  pending?: boolean;
}

/**
 * Full-height, persisted orchestrator chat — distinct from the small
 * AgentChat.tsx popover (which stays as-is for the composer/canvas cases):
 * this one loads/saves history via /api/agent-conversations/[id], supports
 * attaching reference images, and surfaces the design_prompt subagent's
 * output via a trace chip + "Use this prompt" handoff to the composer.
 */
export function OrchestratorChat({
  conversationId,
  onUsePrompt,
}: {
  conversationId: string;
  onUsePrompt: (prompt: string) => void;
}) {
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const [attaching, setAttaching] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const requestIdRef = useRef(0);

  useEffect(() => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    (async () => {
      const res = await fetch(`/api/agent-conversations/${conversationId}`, { cache: "no-store" });
      const json = await res.json().catch(() => ({}));
      if (requestIdRef.current !== requestId) return; // superseded by a newer thread switch
      setMessages(json.messages ?? []);
      setLoading(false);
    })();
  }, [conversationId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, sending]);

  const onFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []).slice(0, MAX_IMAGES - images.length);
    e.target.value = "";
    if (files.length === 0) return;
    setAttaching(true);
    try {
      const encoded = await Promise.all(files.map((f) => encodeBlobWithBudget(f)));
      setImages((cur) => [...cur, ...encoded].slice(0, MAX_IMAGES));
    } finally {
      setAttaching(false);
    }
  };

  const send = async () => {
    const content = input.trim();
    if (!content || sending) return;
    const optimistic: DisplayMessage = {
      id: `pending-${Date.now()}`,
      conversationId,
      role: "user",
      content,
      toolTrace: null,
      createdAt: Date.now(),
    };
    setMessages((cur) => [...cur, optimistic]);
    setInput("");
    const sentImages = images;
    setImages([]);
    setError(null);
    setSending(true);
    try {
      const res = await fetch(`/api/agent-conversations/${conversationId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, images: sentImages }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) {
        throw new Error(data.error || `Request failed (${res.status}).`);
      }
      setMessages((cur) => [
        ...cur.filter((m) => m.id !== optimistic.id),
        data.userMessage,
        data.assistantMessage,
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={scrollRef} className="scroll-thin flex-1 overflow-y-auto px-4 py-6 sm:px-8">
        {loading ? (
          <div className="mx-auto flex max-w-3xl items-center gap-2 text-sm text-white/40">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading chat…
          </div>
        ) : messages.length === 0 ? (
          <div className="mx-auto max-w-3xl text-sm leading-relaxed text-white/40">
            <p className="mb-1 flex items-center gap-1.5 font-medium text-white/60">
              <Sparkles className="h-4 w-4 text-brand" /> New chat
            </p>
            Talk through what you want to make. Attach reference images if you have
            them, and ask for a designed prompt when you're ready.
          </div>
        ) : (
          <div className="mx-auto flex max-w-3xl flex-col gap-4">
            {messages.map((m) => (
              <MessageBubble key={m.id} message={m} onUsePrompt={onUsePrompt} />
            ))}
            {sending && (
              <div className="mr-auto flex items-center gap-1.5 text-xs text-white/40">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Thinking…
              </div>
            )}
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-line px-4 py-3 sm:px-8">
        <div className="mx-auto max-w-3xl">
          {error && (
            <div className="mb-2 flex items-start gap-1.5 rounded-lg border border-red-500/30 bg-red-500/10 px-2.5 py-1.5 text-xs text-red-300">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {error}
            </div>
          )}
          {images.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-2">
              {images.map((src, i) => (
                <div key={i} className="group relative h-14 w-14 overflow-hidden rounded-lg border border-line">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={src} alt={`attachment ${i + 1}`} className="h-full w-full object-cover" />
                  <button
                    type="button"
                    onClick={() => setImages((cur) => cur.filter((_, idx) => idx !== i))}
                    className="absolute right-0.5 top-0.5 grid h-4 w-4 place-items-center rounded-full bg-black/70 text-white/90 opacity-0 transition group-hover:opacity-100"
                  >
                    <X className="h-2.5 w-2.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="flex items-end gap-1.5">
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={attaching || images.length >= MAX_IMAGES}
              title="Attach reference image"
              aria-label="Attach reference image"
              className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-dashed border-white/15 text-white/55 transition hover:border-brand/40 hover:text-brand disabled:cursor-not-allowed disabled:opacity-40"
            >
              {attaching ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImagePlus className="h-4 w-4" />}
            </button>
            <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={onFiles} />
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              rows={1}
              placeholder="Talk through your idea…"
              className="scroll-thin max-h-32 min-h-[2.25rem] flex-1 resize-none rounded-lg border border-line bg-ink-700 px-3 py-2 text-sm text-white placeholder:text-white/30 focus:border-brand/40 focus:outline-none"
            />
            <button
              type="button"
              onClick={send}
              disabled={sending || !input.trim()}
              className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-brand text-ink-900 transition-opacity disabled:opacity-30"
              aria-label="Send"
            >
              <Send className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function MessageBubble({
  message,
  onUsePrompt,
}: {
  message: DisplayMessage;
  onUsePrompt: (prompt: string) => void;
}) {
  const isUser = message.role === "user";
  const designedPrompt =
    message.toolTrace?.tool === "design_prompt"
      ? (message.toolTrace.result as { prompt?: string } | null)?.prompt
      : undefined;

  return (
    <div className={cn("flex flex-col gap-1", isUser ? "items-end" : "items-start")}>
      {designedPrompt && (
        <span className="flex items-center gap-1 text-[11px] font-medium text-brand/80">
          <Wand2 className="h-3 w-3" /> Designed a prompt
        </span>
      )}
      <div
        className={cn(
          "max-w-[85%] whitespace-pre-wrap rounded-xl px-3 py-2 text-sm leading-relaxed",
          isUser ? "bg-brand/15 text-white" : "bg-white/6 text-white/85"
        )}
      >
        {message.content}
      </div>
      {designedPrompt && (
        <button
          type="button"
          onClick={() => onUsePrompt(designedPrompt)}
          className="rounded-full border border-brand/40 px-3 py-1 text-xs font-medium text-brand transition hover:bg-brand/10"
        >
          Use this prompt
        </button>
      )}
    </div>
  );
}
