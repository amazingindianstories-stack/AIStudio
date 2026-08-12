"use client";

import { useEffect, useRef, useState } from "react";
import { AlertCircle, Loader2, Send, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { apiFetch } from "@/lib/api";

const ROLE_LABEL = {
  image: "Image Assistant",
  video: "Video Assistant",
  story: "Story Assistant",
};

const ROLE_EMPTY_HINT = {
  image: "Ask for composition, lighting, or style ideas for this prompt.",
  video: "Ask for camera moves, framing, or pacing ideas for this shot.",
  story: "Ask for a logline, beat breakdown, or a continuity check.",
};

/** Small chat panel backed by /api/agents/{role}. Not streaming in v1 — each
 *  send is one request/response round trip (see route-handler.ts). */
export function AgentChat({ role, context, placeholder, className }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const scrollRef = useRef(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, loading]);

  async function send() {
    const text = input.trim();
    if (!text || loading) return;
    const next = [...messages, { role: "user", content: text }];
    setMessages(next);
    setInput("");
    setError(null);
    setLoading(true);
    try {
      // TODO: streaming — swap this for an SSE/stream reader once the route supports it.
      const res = await apiFetch(`/api/agents/${role}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: next, context }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) {
        throw new Error(data.error || `Request failed (${res.status}).`);
      }
      const reply = data.messages?.[0];
      if (reply?.content) {
        setMessages((cur) => [...cur, { role: "assistant", content: reply.content }]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className={cn("flex h-[26rem] w-80 flex-col", className)}>
      <div className="flex items-center gap-1.5 border-b border-line px-1 pb-2 text-xs font-medium uppercase tracking-wide text-white/50">
        <Sparkles className="h-3.5 w-3.5 text-brand" />
        {ROLE_LABEL[role]}
      </div>
      <div
        ref={scrollRef}
        className="scroll-thin flex-1 space-y-3 overflow-y-auto px-1 py-3"
      >
        {messages.length === 0 && !loading && (
          <p className="text-xs leading-relaxed text-white/40">{ROLE_EMPTY_HINT[role]}</p>
        )}
        {messages.map((m, i) => (
          <div
            key={i}
            className={cn(
              "max-w-[90%] whitespace-pre-wrap rounded-lg px-2.5 py-1.5 text-sm leading-snug",
              m.role === "user"
                ? "ml-auto bg-brand/15 text-white"
                : "mr-auto bg-white/6 text-white/85"
            )}
          >
            {m.content}
          </div>
        ))}
        {loading && (
          <div className="mr-auto flex items-center gap-1.5 text-xs text-white/40">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Thinking…
          </div>
        )}
      </div>
      {error && (
        <div className="mb-2 flex items-start gap-1.5 rounded-lg border border-red-500/30 bg-red-500/10 px-2 py-1.5 text-xs text-red-300">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {error}
        </div>
      )}
      <div className="flex items-end gap-1.5 border-t border-line pt-2">
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
          placeholder={placeholder || "Ask for help…"}
          className="scroll-thin max-h-24 min-h-[2.25rem] flex-1 resize-none rounded-lg border border-line bg-ink-700 px-2.5 py-2 text-sm text-white placeholder:text-white/30 focus:border-brand/40 focus:outline-none"
        />
        <button
          type="button"
          onClick={send}
          disabled={loading || !input.trim()}
          className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-brand text-ink-900 transition-opacity disabled:opacity-30"
          aria-label="Send"
        >
          <Send className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
