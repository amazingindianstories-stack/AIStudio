"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Bot, Check, ChevronDown, Loader2, MessageSquarePlus, Plus, Send, Trash2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatCost } from "@/lib/format-cost";
import { MAX_SOURCES, useSidekick, slashMatches } from "@/lib/sidekick";
import { fetchProjectBoards } from "@/lib/sidekick-api";
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
export function SidekickPanel({ boardId, projectId, initialTab = "chat", onClose }) {
  const [tab, setTab] = useState(initialTab);
  const attach = useSidekick((s) => s.attach);
  const detach = useSidekick((s) => s.detach);
  const error = useSidekick((s) => s.error);

  useEffect(() => {
    void attach(boardId);
    return () => detach();
  }, [boardId, attach, detach]);

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
        {TABS.map((item) => (
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
        {tab === "chat" && <ChatTab boardId={boardId} projectId={projectId} />}
        {tab === "flows" && <FlowsTab boardId={boardId} />}
        {tab === "catchup" && <CatchUpTab boardId={boardId} />}
      </div>
    </section>
  );
}

function allSidekicks(catalogue) {
  return catalogue ? [...catalogue.premade, ...catalogue.custom] : [];
}

function ChatTab({ boardId, projectId }) {
  const catalogue = useSidekick((s) => s.catalogue);
  const sidekickId = useSidekick((s) => s.sidekickId);
  const chats = useSidekick((s) => s.chats);
  const chatId = useSidekick((s) => s.chatId);
  const turns = useSidekick((s) => s.turns);
  const quote = useSidekick((s) => s.quote);
  const sending = useSidekick((s) => s.sending);
  const credits = useSidekick((s) => s.credits);
  const [draft, setDraft] = useState("");
  const [processing, setProcessing] = useState(null);
  const [editing, setEditing] = useState(null);
  const [showChats, setShowChats] = useState(false);
  const [showSources, setShowSources] = useState(false);
  const sources = useSidekick((s) => s.sources);
  const endRef = useRef(null);
  const sidekicks = useMemo(() => allSidekicks(catalogue), [catalogue]);
  const current = sidekicks.find((item) => item.id === sidekickId) ?? sidekicks[0];
  const selectionCount = useCanvasStore((s) => s.selection.length);
  const options = useMemo(() => ({
    processing: processing ?? current?.processing ?? "basic",
  }), [processing, current]);
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
  }, [draft, options, sources]);

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
            disabled={busy}
            onChange={(event) => useSidekick.getState().chooseSidekick(event.target.value)}
            className="w-full appearance-none rounded-lg border border-line bg-ink-900/60 py-1.5 pl-2.5 pr-7 text-xs text-white/85 disabled:opacity-60"
          >
            <optgroup label="Specialists">
              {catalogue.premade.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </optgroup>
            {catalogue.custom.length > 0 && (
              <optgroup label="Custom">
                {catalogue.custom.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
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
        {turns.map((turn) => <Turn key={turn.id} turn={turn} onOption={setDraft} busy={busy} />)}
        <div ref={endRef} />
      </div>

      <div className="relative border-t border-line p-3">
        {showSources && matches.length === 0 && <SourcePicker boardId={boardId} projectId={projectId} onClose={() => setShowSources(false)} />}
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
          <select aria-label="Processing" value={options.processing} onChange={(event) => setProcessing(event.target.value)} className="rounded-md border border-line bg-ink-900/60 px-1.5 py-1 text-white/70">
            <option value="basic">Basic</option>
            <option value="advanced">Advanced</option>
          </select>
          <button
            type="button"
            aria-expanded={showSources}
            onClick={() => setShowSources((v) => !v)}
            title="Let the Sidekick read other boards or this project's library"
            className={cn("rounded-md border border-line px-1.5 py-1 hover:bg-white/[0.07] hover:text-white", sources.length ? "text-white/85" : "text-white/60")}
          >
            Sources{sources.length ? ` (${sources.length})` : ""}
          </button>
          <span className="ml-auto text-white/55" data-testid="sidekick-cost">{exhausted ? "Out of AI credits" : quote ? `~${formatCost(quote.costCents)}` : ""}</span>
          <button type="button" onClick={() => void send()} disabled={busy || !draft.trim() || exhausted} className="flex items-center gap-1 rounded-md bg-brand px-2.5 py-1 font-medium text-white disabled:opacity-40">
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Send className="h-3.5 w-3.5" aria-hidden />}Send
          </button>
        </div>
      </div>
    </>
  );
}

/** Other Veevee places the next messages may read: boards in this project the user can open, and its library prompts. */
function SourcePicker({ boardId, projectId, onClose }) {
  const sources = useSidekick((s) => s.sources);
  const [boards, setBoards] = useState(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!projectId) return undefined;
    let live = true;
    fetchProjectBoards(projectId).then(
      (list) => live && setBoards(list.filter((item) => item.id !== boardId)),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [boardId, projectId]);

  const full = sources.length >= MAX_SOURCES;
  const items = [{ kind: "library", label: "This project's library prompts" }, ...(boards ?? []).map((item) => ({ kind: "board", id: item.id, label: item.name }))];
  return (
    <div role="group" aria-label="Sources" className="absolute bottom-full left-3 right-3 mb-1 max-h-56 overflow-y-auto rounded-lg border border-line bg-ink-800 p-1 shadow-pop">
      <div className="flex items-center px-2 py-1 text-[11px] text-white/45">
        <span>Read up to {MAX_SOURCES} sources with each message</span>
        <button type="button" aria-label="Close sources" onClick={onClose} className="ml-auto grid h-5 w-5 place-items-center rounded text-white/45 hover:text-white"><X className="h-3.5 w-3.5" /></button>
      </div>
      {items.map((item) => {
        const chosen = sources.some((source) => source.kind === item.kind && source.id === item.id);
        return (
          <button
            key={item.id ?? item.kind}
            type="button"
            role="checkbox"
            aria-checked={chosen}
            disabled={!chosen && full}
            onClick={() => useSidekick.getState().toggleSource({ kind: item.kind, id: item.id })}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-white/80 hover:bg-white/[0.07] disabled:opacity-40"
          >
            <span className={cn("grid h-3.5 w-3.5 shrink-0 place-items-center rounded border", chosen ? "border-brand bg-brand text-white" : "border-line")}>{chosen && <Check className="h-3 w-3" aria-hidden />}</span>
            <span className="truncate">{item.label}</span>
          </button>
        );
      })}
      {boards === null && !failed && projectId && <p className="px-2 py-1.5 text-xs text-white/45">Loading boards…</p>}
      {failed && <p className="px-2 py-1.5 text-xs text-red-300">Could not load this project&apos;s boards.</p>}
      {boards?.length === 0 && <p className="px-2 py-1.5 text-xs text-white/45">No other boards in this project.</p>}
    </div>
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
