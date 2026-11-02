"use client";

import { useCallback, useEffect, useState } from "react";
import { Clock, Eye, EyeOff, Pencil, Play, Trash2, Trophy } from "lucide-react";
import { cn } from "@/lib/utils";
import { useFacilitationStore } from "@/lib/canvas/facilitation-store";
import { MAX_VOTES_PER_PERSON, durationLabel, votesLeft } from "@/lib/canvas/facilitation";
import { useCanvasStore } from "@/lib/canvas-store";
import { canCommentRole, canEditRole } from "@/lib/board-access";

const FIELD = "rounded-md border border-line bg-ink-800 px-2 py-1 text-white outline-none focus:border-brand";
const PILL = "rounded-full border border-line px-3 py-1 text-xs font-medium text-white/85 outline-none transition hover:text-white focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-40";
const OBJECT_TYPES = [
  { id: "sticky", label: "Sticky notes" },
  { id: "text", label: "Text" },
  { id: "image", label: "Images" },
  { id: "shape", label: "Shapes" },
  { id: "frame", label: "Frames" },
];

const selectedNodes = () => {
  const state = useCanvasStore.getState();
  const ids = new Set(state.selection);
  return state.history.present.nodes.filter((node) => ids.has(node.id));
};

/** The area a session covers from the current selection: one frame, or the box around several objects. */
export function areaFromSelection(nodes) {
  if (!nodes.length) return null;
  if (nodes.length === 1 && nodes[0].type === "frame") return { frameId: nodes[0].id };
  const left = Math.min(...nodes.map((node) => node.x));
  const top = Math.min(...nodes.map((node) => node.y));
  const right = Math.max(...nodes.map((node) => node.x + node.w));
  const bottom = Math.max(...nodes.map((node) => node.y + node.h));
  return { x: left, y: top, w: right - left, h: bottom - top };
}

/** Set up a voting session: how many votes, what can be voted on and where, how long it runs. */
export function VotingSetup({ onClose }) {
  const [name, setName] = useState("Voting session");
  const [votes, setVotes] = useState(3);
  const [oneVote, setOneVote] = useState(false);
  const [types, setTypes] = useState(["sticky"]);
  const [anyType, setAnyType] = useState(false);
  const [useArea, setUseArea] = useState(false);
  const [minutes, setMinutes] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const area = useArea ? areaFromSelection(selectedNodes()) : null;
  const submit = async (saveForLater) => {
    setBusy(true);
    setError("");
    try {
      await useFacilitationStore.getState().createSession({
        name: name.trim(),
        votesPerPerson: votes,
        oneVotePerObject: oneVote,
        objectTypes: anyType ? null : types,
        area,
        durationMs: minutes > 0 ? Math.round(minutes * 60000) : null,
        saveForLater,
      });
      onClose();
    } catch (failure) {
      setError(failure.message);
      setBusy(false);
    }
  };
  return (
    <form data-voting-setup="" className="flex flex-col gap-3 p-3 text-xs text-white/75" onSubmit={(e) => { e.preventDefault(); void submit(false); }}>
      <label className="flex flex-col gap-1">
        Name
        <input aria-label="Session name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} className={FIELD} />
      </label>
      <label className="flex items-center justify-between gap-3">
        Votes per person
        <input aria-label="Votes per person" type="number" min={1} max={MAX_VOTES_PER_PERSON} value={votes}
          onChange={(e) => setVotes(Math.min(MAX_VOTES_PER_PERSON, Math.max(1, Math.round(Number(e.target.value)) || 1)))}
          className={cn(FIELD, "w-20 text-right")} />
      </label>
      <label className="flex items-center gap-2"><input type="checkbox" checked={oneVote} onChange={(e) => setOneVote(e.target.checked)} /> One vote per object</label>
      <fieldset className="flex flex-col gap-1">
        <legend className="mb-1">Objects people can vote on</legend>
        <label className="flex items-center gap-2"><input type="checkbox" checked={anyType} onChange={(e) => setAnyType(e.target.checked)} /> Anything</label>
        {!anyType && (
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            {OBJECT_TYPES.map((type) => (
              <label key={type.id} className="flex items-center gap-1.5">
                <input type="checkbox" checked={types.includes(type.id)}
                  onChange={(e) => setTypes((current) => (e.target.checked ? [...current, type.id] : current.filter((id) => id !== type.id)))} />
                {type.label}
              </label>
            ))}
          </div>
        )}
      </fieldset>
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={useArea} onChange={(e) => setUseArea(e.target.checked)} />
        Only the selected frame or objects
      </label>
      {useArea && !area && <p className="text-amber-200">Select a frame or some objects on the board first.</p>}
      <label className="flex items-center justify-between gap-3">
        Duration (minutes, 0 for no limit)
        <input aria-label="Duration in minutes" type="number" min={0} max={480} step={0.5} value={minutes}
          onChange={(e) => setMinutes(Math.min(480, Math.max(0, Number(e.target.value) || 0)))} className={cn(FIELD, "w-20 text-right")} />
      </label>
      {error && <p role="alert" className="text-red-300">{error}</p>}
      <div className="flex gap-2">
        <button type="submit" disabled={busy || !name.trim() || (!anyType && !types.length) || (useArea && !area)}
          className="rounded-lg bg-brand px-3 py-1.5 text-sm font-semibold text-ink-900 outline-none hover:bg-brand/90 focus-visible:ring-2 focus-visible:ring-white disabled:opacity-40">
          Start voting
        </button>
        <button type="button" disabled={busy || !name.trim() || (!anyType && !types.length) || (useArea && !area)} onClick={() => void submit(true)} className={PILL}>
          Save for later
        </button>
      </div>
    </form>
  );
}

/** The running session as the voter sees it, with the facilitator's controls when they can edit the board. */
export function VotingBar() {
  const active = useFacilitationStore((s) => s.voting.active);
  const role = useCanvasStore((s) => s.boardRole);
  if (!active) return null;
  const store = useFacilitationStore.getState();
  const facilitator = canEditRole(role);
  const voter = canCommentRole(role);
  const quietly = (promise) => void promise.catch(() => {});
  return (
    <div data-voting-bar="" role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-2xl border border-line bg-ink-750/95 px-3 py-1.5 text-xs text-white/80 shadow-pop backdrop-blur-xl">
      <span className="font-semibold text-white">{active.name}</span>
      {voter && (
        <span data-votes-left>{active.done ? "You are done" : `${votesLeft(active)} of ${active.votesPerPerson} votes left`}</span>
      )}
      {active.endsAt && <VotingClock endsAt={active.endsAt} />}
      {facilitator && active.progress && (
        <span data-voting-progress>{active.progress.voted} voted, {active.progress.done} done</span>
      )}
      {voter && (
        <button type="button" onClick={() => quietly(store.markDone(active.id, !active.done))} className={PILL}>
          {active.done ? "Keep voting" : "I'm done"}
        </button>
      )}
      {facilitator && (
        <>
          {active.endsAt && (
            <button type="button" onClick={() => quietly(store.sessionAction(active.id, { action: "addTime", addMs: 60000 }))} className={PILL}>+1 min</button>
          )}
          <button type="button" onClick={() => quietly(store.sessionAction(active.id, { action: "end" }))} className={cn(PILL, "border-brand text-brand")}>
            End voting
          </button>
        </>
      )}
    </div>
  );
}

function VotingClock({ endsAt }) {
  const offset = useFacilitationStore((s) => s.offset);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(interval);
  }, []);
  const left = Math.max(0, endsAt - (now + offset));
  return (
    <span className="flex items-center gap-1 tabular-nums"><Clock className="h-3 w-3" />{durationLabel(Math.ceil(left / 1000) * 1000)} left</span>
  );
}

/** Past and saved sessions with their results; the facilitator can show, rename, delete and start them. */
export function VotingHistory() {
  const [sessions, setSessions] = useState(null);
  const [error, setError] = useState("");
  const active = useFacilitationStore((s) => s.voting.active);
  const shown = useFacilitationStore((s) => s.voting.shown);
  const role = useCanvasStore((s) => s.boardRole);
  const facilitator = canEditRole(role);
  const load = useCallback(async () => {
    try {
      setSessions(await useFacilitationStore.getState().listSessions());
    } catch (failure) {
      setError(failure.message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load, active?.id, shown?.id]);
  const run = async (sessionId, data) => {
    setError("");
    try {
      await useFacilitationStore.getState().sessionAction(sessionId, data);
      await load();
    } catch (failure) {
      setError(failure.message);
    }
  };
  if (sessions === null) return <p className="p-3 text-xs text-white/50">{error || "Loading..."}</p>;
  if (!sessions.length) return <p className="p-3 text-xs text-white/50">No voting sessions yet.</p>;
  return (
    <div data-voting-history="" className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto p-3">
      {error && <p role="alert" className="text-xs text-red-300">{error}</p>}
      {sessions.map((session) => (
        <section key={session.id} data-voting-session={session.id} className="rounded-xl border border-line bg-ink-800/60 p-2.5">
          <header className="flex items-center gap-2">
            <h3 className="min-w-0 flex-1 truncate text-sm font-semibold text-white">{session.name}</h3>
            <span className="rounded-full bg-white/10 px-2 py-0.5 text-[11px] capitalize text-white/70">{session.status}</span>
          </header>
          {session.status === "ended" && (
            <>
              <p className="mt-1 text-[11px] text-white/50">{session.totalVotes} votes from {session.participants} {session.participants === 1 ? "person" : "people"}</p>
              <ol className="mt-1.5 flex flex-col gap-1">
                {session.results.map((row, index) => (
                  <li key={row.nodeId} data-result-row className={cn("flex items-center gap-2 rounded-md px-2 py-1 text-xs", row.top ? "bg-brand/10 text-white" : "text-white/70")}>
                    {row.top ? <Trophy className="h-3 w-3 text-brand" /> : <span className="w-3 text-center text-white/40">{index + 1}</span>}
                    <span className="min-w-0 flex-1 truncate">{resultLabel(row)}</span>
                    <span className="tabular-nums">{row.votes}</span>
                  </li>
                ))}
                {!session.results.length && <li className="text-xs text-white/50">No votes were cast.</li>}
              </ol>
            </>
          )}
          {facilitator && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {session.status === "saved" && (
                <button type="button" disabled={Boolean(active)} onClick={() => void run(session.id, { action: "start" })} className={PILL}><Play className="mr-1 inline h-3 w-3" />Start</button>
              )}
              {session.status === "ended" && (
                <button type="button" aria-pressed={session.showOnBoard} onClick={() => void run(session.id, { action: "showOnBoard", value: !session.showOnBoard })} className={PILL}>
                  {session.showOnBoard ? <EyeOff className="mr-1 inline h-3 w-3" /> : <Eye className="mr-1 inline h-3 w-3" />}
                  {session.showOnBoard ? "Hide results on board" : "Keep results on board"}
                </button>
              )}
              <button type="button" onClick={() => {
                const name = window.prompt("Rename voting session", session.name);
                if (name && name.trim()) void run(session.id, { action: "rename", name: name.trim() });
              }} className={PILL}><Pencil className="mr-1 inline h-3 w-3" />Rename</button>
              {session.status !== "active" && (
                <button type="button" onClick={() => { if (window.confirm(`Delete "${session.name}"?`)) void run(session.id, { action: "delete" }); }} className={PILL}><Trash2 className="mr-1 inline h-3 w-3" />Delete</button>
              )}
            </div>
          )}
        </section>
      ))}
    </div>
  );
}

function resultLabel(row) {
  if (!row.present) return "Deleted object";
  return row.label || (row.label === null && row.type === "sticky" ? "Hidden note" : row.type ?? "Object");
}


