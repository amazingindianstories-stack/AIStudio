"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Bot, ChevronDown, Globe, Loader2, MessageSquarePlus, Plus, Send, Trash2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatCost } from "@/lib/format-cost";
import { useSidekick, slashMatches } from "@/lib/sidekick";
import { useCanvasStore } from "@/lib/canvas-store";
import { FlowsTab } from "./SidekickFlows";
import { CatchUpTab } from "./SidekickCatchUp";
import { SidekickEditor } from "./SidekickEditor";

const TABS = [
  { id: "chat", label: "Chat" },
  { id: "flows", label: "Flows" },
  { id: "catchup", label: "Catch up" },
];
const QUOTE_DELAY_MS = 350;

export function CreditsChip({ className }) {
  const credits = useSidekick((s) => s.credits);
  if (!credits) return null;
  const low = credits.remainingCents <= credits.capCents * 0.1;
  return (
    <span
      title={`${formatCost(credits.usedCents)} of ${formatCost(credits.capCents)} AI credits used this month. Resets ${new Date(credits.resetsAt).toLocaleDateString()}.`}
      className={cn("rounded-md px-1.5 py-0.5 text-[11px] font-medium", low ? "bg-red-500/15 text-red-300" : "bg-white/[0.07] text-white/60", className)}
    >
      {formatCost(credits.remainingCents)} left
    </span>
  );
}

/**
 * The board's AI teammate: chat with a Sidekick (premade or your own), run Flows, and catch up on what changed. It
 * docks on the right. Every paid action shows its price first and starts only when you press it.
 */
export function SidekickPanel({ boardId, initialTab = "chat", readOnly = false, onClose }) {
  const tabs = readOnly ? TABS.filter((item) => item.id === "catchup") : TABS;
  const [tab, setTab] = useState(readOnly ? "catchup" : initialTab);
  const attach = useSidekick((s) => s.attach);
  const detach = useSidekick((s) => s.detach);
  const error = useSidekick((s) => s.error);

  useEffect(() => {
    // Viewers and commenters only catch up: chats and Flows write to the board and need edit access.
    if (readOnly) void useSidekick.getState().loadCredits();
    else void attach(boardId);
    return () => detach();
  }, [boardId, readOnly, attach, detach]);

  return (
    <section
      aria-label="Sidekick"
      className="absolute bottom-[72px] right-4 top-16 z-[45] flex w-[min(380px,calc(100%-32px))] flex-col rounded-2xl border border-line bg-ink-750/95 shadow-pop backdrop-blur-xl"
      onKeyDown={(event) => {
        if (event.key === "Escape" && event.target.tagName !== "TEXTAREA") onClose();
      }}
    >
      <header className="flex items-center gap-2 border-b border-line px-3 py-2.5">
        <Bot className="h-4 w-4 text-brand" aria-hidden />
        <h2 className="text-sm font-semibold text-white/90">Sidekick</h2>
        <CreditsChip className="ml-1" />
        <button type="button" aria-label="Close Sidekick" title="Close" onClick={onClose} className="ml-auto grid h-7 w-7 place-items-center rounded-md text-white/50 transition-colors hover:bg-white/[0.07] hover:text-white">
          <X className="h-4 w-4" />
        </button>
      </header>
      <div role="tablist" aria-label="Sidekick sections" className="flex gap-1 px-3 pt-2">
        {tabs.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            onClick={() => setTab(item.id)}
            className={cn("rounded-md px-2.5 py-1 text-xs font-medium transition-colors", tab === item.id ? "bg-ink-600 text-white ring-1 ring-line" : "text-white/55 hover:bg-white/[0.07] hover:text-white")}
          >
            {item.label}
          </button>
        ))}
      </div>
      {error && (
        <p role="alert" className="mx-3 mt-2 rounded-md bg-red-500/10 px-2.5 py-1.5 text-xs text-red-300">
          {error}
          <button type="button" className="ml-2 underline" onClick={() => useSidekick.getState().dismissError()}>Dismiss</button>
        </p>
      )}
      <div className="flex min-h-0 flex-1 flex-col">
        {tab === "chat" && <ChatTab />}
        {tab === "flows" && <FlowsTab boardId={boardId} />}
        {tab === "catchup" && <CatchUpTab boardId={boardId} />}
      </div>
    </section>
  );
}

function allSidekicks(catalogue) {
  return catalogue ? [...catalogue.premade, ...catalogue.custom] : [];
}

function ChatTab() {
  const catalogue = useSidekick((s) => s.catalogue);
  const sidekickId = useSidekick((s) => s.sidekickId);
  const chats = useSidekick((s) => s.chats);
  const chatId = useSidekick((s) => s.chatId);
  const turns = useSidekick((s) => s.turns);
  const quote = useSidekick((s) => s.quote);
  const sending = useSidekick((s) => s.sending);
  const credits = useSidekick((s) => s.credits);
  const [draft, setDraft] = useState("");
  const [web, setWeb] = useState(null);
  const [processing, setProcessing] = useState(null);
  const [editing, setEditing] = useState(null);
  const [showChats, setShowChats] = useState(false);
  const endRef = useRef(null);
  const sidekicks = useMemo(() => allSidekicks(catalogue), [catalogue]);
  const current = sidekicks.find((item) => item.id === sidekickId) ?? sidekicks[0];
  const selectionCount = useCanvasStore((s) => s.selection.length);
  const options = useMemo(() => ({
    webSearch: web ?? current?.webSearch ?? false,
    processing: processing ?? current?.processing ?? "basic",
  }), [web, processing, current]);
  const lastStatus = turns[turns.length - 1]?.status;
  const busy = sending || turns.some((turn) => ["queued", "running"].includes(turn.status));
  const matches = slashMatches(draft, catalogue?.skills);
  const exhausted = credits && credits.remainingCents <= 0;

  useEffect(() => {
    if (!draft.trim()) {
      useSidekick.setState({ quote: null });
      return undefined;
    }
    const timer = setTimeout(() => void useSidekick.getState().estimate(draft, options), QUOTE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [draft, options]);

  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: "end" });
  }, [turns.length, lastStatus]);

  const send = async (text = draft) => {
    if (busy || !text.trim() || exhausted) return;
    const job = await useSidekick.getState().send(text, options);
    if (job) setDraft("");
  };

  if (!catalogue) return <p className="p-4 text-xs text-white/50">Loading Sidekicks…</p>;
  if (editing !== null) return <SidekickEditor sidekick={editing} onDone={() => setEditing(null)} />;

  return (
    <>
      <div className="flex items-center gap-1.5 px-3 pt-2">
        <label className="sr-only" htmlFor="sidekick-picker">Sidekick</label>
        <div className="relative min-w-0 flex-1">
          <select
            id="sidekick-picker"
            value={current?.id ?? ""}
            onChange={(event) => useSidekick.getState().chooseSidekick(event.target.value)}
            className="w-full appearance-none rounded-lg border border-line bg-ink-900/60 py-1.5 pl-2.5 pr-7 text-xs text-white/85"
          >
            <optgroup label="Specialists">
              {catalogue.premade.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </optgroup>
            {catalogue.custom.length > 0 && (
              <optgroup label="Custom">
                {catalogue.custom.map((item) => <option key={item.id} value={item.id}>{item.name}{item.mine ? "" : " (shared)"}</option>)}
              </optgroup>
            )}
          </select>
          <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-white/45" aria-hidden />
        </div>
        <button type="button" aria-label="New Sidekick" title="New Sidekick" onClick={() => setEditing({})} className="grid h-7 w-7 place-items-center rounded-md text-white/55 hover:bg-white/[0.07] hover:text-white"><Plus className="h-4 w-4" /></button>
        {current?.custom && current.mine && (
          <button type="button" onClick={() => setEditing(current)} className="rounded-md px-1.5 py-1 text-xs text-white/60 hover:bg-white/[0.07] hover:text-white">Edit</button>
        )}
        <button type="button" aria-label="Chat history" aria-expanded={showChats} title="Chat history" onClick={() => setShowChats((v) => !v)} className={cn("rounded-md px-1.5 py-1 text-xs hover:bg-white/[0.07] hover:text-white", showChats ? "bg-white/[0.07] text-white" : "text-white/60")}>History</button>
        <button type="button" aria-label="New chat" title="New chat" onClick={() => useSidekick.getState().newChat()} className="grid h-7 w-7 place-items-center rounded-md text-white/55 hover:bg-white/[0.07] hover:text-white"><MessageSquarePlus className="h-4 w-4" /></button>
      </div>
      {current?.description && <p className="px-3 pt-1.5 text-[11px] leading-snug text-white/45">{current.description}</p>}

      {showChats && (
        <ul aria-label="Chats" className="mx-3 mt-2 max-h-36 overflow-y-auto rounded-lg bg-ink-900/60 p-1">
          {chats.length === 0 ? <li className="px-2 py-1.5 text-xs text-white/45">No saved chats on this board yet.</li> : chats.map((chat) => (
            <li key={chat.id} className={cn("flex items-center gap-1 rounded-md px-2 py-1 text-xs", chat.id === chatId ? "bg-white/[0.07] text-white" : "text-white/70")}>
              <button type="button" className="min-w-0 flex-1 truncate text-left" onClick={() => { void useSidekick.getState().openChat(chat.id); setShowChats(false); }}>{chat.title}</button>
              <button type="button" aria-label={`Delete chat ${chat.title}`} onClick={() => void useSidekick.getState().deleteChat(chat.id)} className="shrink-0 text-white/40 hover:text-red-300"><Trash2 className="h-3.5 w-3.5" /></button>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-2 min-h-0 flex-1 space-y-3 overflow-y-auto px-3 pb-2" aria-live="polite">
        {turns.length === 0 && (
          <div className="space-y-2 pt-2">
            <p className="text-xs text-white/50">Ask {current?.name ?? "a Sidekick"} about this board{selectionCount ? ` (${selectionCount} selected object${selectionCount === 1 ? "" : "s"} will be starred)` : ""}. Type / for quick commands.</p>
            <div className="flex flex-wrap gap-1.5">
              {(current?.starters ?? []).map((starter) => (
                <button key={starter} type="button" onClick={() => setDraft(starter)} className="rounded-full border border-line px-2.5 py-1 text-left text-xs text-white/70 hover:bg-white/[0.07] hover:text-white">{starter}</button>
              ))}
            </div>
          </div>
        )}
        {turns.map((turn) => <Turn key={turn.id} turn={turn} onOption={(text) => void send(text)} busy={busy} />)}
        <div ref={endRef} />
      </div>

      <div className="relative border-t border-line p-3">
        {matches.length > 0 && (
          <ul role="listbox" aria-label="Commands" className="absolute bottom-full left-3 right-3 mb-1 overflow-hidden rounded-lg border border-line bg-ink-800 shadow-pop">
            {matches.map((skill) => (
              <li key={skill.name}>
                <button type="button" role="option" aria-selected="false" onClick={() => setDraft(`/${skill.name} `)} className="flex w-full items-baseline gap-2 px-2.5 py-1.5 text-left text-xs hover:bg-white/[0.07]">
                  <span className="font-medium text-white/90">/{skill.name}</span>
                  <span className="truncate text-white/50">{skill.description}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void send();
            } else if (event.key === "Escape") {
              event.preventDefault();
              if (draft) setDraft("");
              else event.currentTarget.blur();
            }
          }}
          rows={2}
          aria-label="Message the Sidekick"
          placeholder="Ask for ideas, a summary, or changes to the board"
          className="w-full resize-none rounded-lg border border-line bg-ink-900/60 px-2.5 py-2 text-sm text-white/90 placeholder:text-white/35"
        />
        <div className="mt-2 flex items-center gap-2 text-xs">
          <button type="button" aria-pressed={options.webSearch} title="Let the Sidekick search the web" onClick={() => setWeb(!options.webSearch)} className={cn("flex items-center gap-1 rounded-md px-1.5 py-1 hover:bg-white/[0.07]", options.webSearch ? "bg-white/[0.07] text-white" : "text-white/55")}>
            <Globe className="h-3.5 w-3.5" aria-hidden />Web
          </button>
          <select aria-label="Processing" value={options.processing} onChange={(event) => setProcessing(event.target.value)} className="rounded-md border border-line bg-ink-900/60 px-1.5 py-1 text-white/70">
            <option value="basic">Basic</option>
            <option value="advanced">Advanced</option>
          </select>
          <span className="ml-auto text-white/55" data-testid="sidekick-cost">{exhausted ? "Out of AI credits" : quote ? `~${formatCost(quote.costCents)}` : ""}</span>
          <button type="button" onClick={() => void send()} disabled={busy || !draft.trim() || exhausted} className="flex items-center gap-1 rounded-md bg-brand px-2.5 py-1 font-medium text-white disabled:opacity-40">
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Send className="h-3.5 w-3.5" aria-hidden />}Send
          </button>
        </div>
      </div>
    </>
  );
}

function Turn({ turn, onOption, busy }) {
  const result = turn.result;
  const running = ["queued", "running"].includes(turn.status);
  return (
    <div className="space-y-1.5">
      <p className="ml-6 rounded-xl rounded-br-sm bg-ink-600 px-3 py-2 text-sm text-white/90">{turn.prompt}</p>
      <div className="mr-6 rounded-xl rounded-bl-sm bg-ink-900/60 px-3 py-2 text-sm text-white/85">
        {running && <p className="flex items-center gap-1.5 text-xs text-white/55"><Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />{turn.heldReason || turn.progressMessage || "Thinking…"}</p>}
        {turn.status === "failed" && <p className="text-xs text-red-300">{turn.error || "The Sidekick could not answer."}</p>}
        {turn.status === "cancelled" && <p className="text-xs text-white/50">Cancelled.</p>}
        {result && (
          <>
            <p className="whitespace-pre-wrap">{result.reply}</p>
            {result.plan?.length > 0 && <ol className="mt-1.5 list-decimal space-y-0.5 pl-5 text-xs text-white/65">{result.plan.map((step, i) => <li key={i}>{step}</li>)}</ol>}
            {result.options?.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {result.options.map((option) => <button key={option} type="button" disabled={busy} onClick={() => onOption(option)} className="rounded-full border border-line px-2.5 py-1 text-xs text-white/75 hover:bg-white/[0.07] disabled:opacity-40">{option}</button>)}
              </div>
            )}
            {(turn.applied || turn.placedNodeIds?.length > 0) && <p className="mt-1.5 text-[11px] text-white/45">Board: {turn.applied ?? `added ${turn.placedNodeIds.length}`}. Undo with Ctrl/Cmd+Z.</p>}
          </>
        )}
        {turn.status === "succeeded" && typeof turn.costCents === "number" && <p className="mt-1 text-[11px] text-white/35">{formatCost(turn.costCents)}</p>}
      </div>
    </div>
  );
}
