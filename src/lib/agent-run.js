/**
 * The Agents tab's view of a durable run, folded from its event feed (`GET .../runs/<run>/events`).
 *
 *   let state = restoreRunState(run);          // or runState(run) for a run this tab just started
 *   state = await drainFeed(state, (after) => fetchEvents(run.id, after));
 *   saveRunState(state);
 *   const view = runView(state);   // timeline, quote, pause, stop and outcome for StudioChat
 *
 * Events are kept by `seq`, so a duplicate or out-of-order page changes nothing and polling from 0 again is safe. The
 * cursor only advances over seqs with no gap below them (the server allocates seqs without gaps), so a page that
 * arrives early never makes the next poll skip events.
 */

import { dollars } from "./agent-access";

export const ACTIVE_STATUSES = ["queued", "running", "waiting_approval", "waiting_jobs", "paused_limit"];
export const TERMINAL_STATUSES = ["completed", "failed", "cancelled"];
/** Pages one drain follows through `more` before it yields to the next poll. */
export const MAX_DRAIN_PAGES = 20;
/** At or above this many cents an approval needs a second, explicit confirmation in the quote card. */
export const CONFIRM_CENTS = 100;

const POLL_MS = 1500;
const IDLE_POLL_MS = 5000;
const MAX_BACKOFF_MS = 30000;
const SAVED_KEY = "veevee.agentRun.";

export function isActiveStatus(status) {
  return ACTIVE_STATUSES.includes(status);
}

export function isTerminalStatus(status) {
  return TERMINAL_STATUSES.includes(status);
}

/** A fresh state for `run` (the run JSON) that reads the feed from the start. */
export function runState(run) {
  return { run, events: {}, cursor: 0, more: true, pending: null, inbox: {}, reach: 0 };
}

function newer(current, next) {
  if (!next || (current && next.id !== current.id)) return current;
  return !current || (next.updatedAt ?? 0) >= (current.updatedAt ?? 0) ? next : current;
}

/** Folds one feed page into `state`, returning a new state; a page for another run changes nothing. */
export function applyPage(state, page) {
  if (!page || (page.run && state.run && page.run.id !== state.run.id)) return state;
  const events = { ...state.events };
  let top = 0;
  for (const event of page.events || []) {
    if (!Number.isInteger(event?.seq) || event.seq < 1) continue;
    events[event.seq] ??= event;
    top = Math.max(top, event.seq);
  }
  let cursor = state.cursor;
  while (events[cursor + 1]) cursor += 1;
  const inbox = { ...state.inbox };
  for (const row of page.pendingMessages || []) inbox[row.id] = { ...inbox[row.id], ...row };
  // The feed reads its events before the inbox, so the snapshot covers every message queued up to the page's last seq.
  const reach = Math.max(top, Number(page.nextAfter) || 0);
  const pending = !state.pending || reach >= state.pending.reach
    ? { ids: (page.pendingMessages || []).map((row) => row.id), reach } : state.pending;
  // `more` belongs to the newest page: an older page answering late must not end a drain.
  const more = reach >= state.reach ? Boolean(page.more) || cursor < reach : state.more;
  return { ...state, run: newer(state.run, page.run), events, cursor, more, pending, inbox, reach: Math.max(state.reach, reach) };
}

/** Remembers a message the composer queued (the 202 `inbox` row) so the thread can show it before the next poll. */
export function addQueuedMessage(state, inbox, run) {
  if (!inbox?.id) return state;
  return { ...state, run: newer(state.run, run), inbox: { ...state.inbox, [inbox.id]: { ...state.inbox[inbox.id], ...inbox, local: true } } };
}

/** Whether the run has ended and every event up to its end has been read. */
export function isSettled(state) {
  return isTerminalStatus(state.run?.status) && !state.more;
}

/** Follows `more` until the feed is drained (or `maxPages` pages were read); `fetchPage(after)` resolves to a page. */
export async function drainFeed(state, fetchPage, { maxPages = MAX_DRAIN_PAGES } = {}) {
  let current = state;
  for (let index = 0; index < maxPages; index += 1) {
    const page = await fetchPage(current.cursor);
    const next = applyPage(current, page);
    const stuck = next.cursor === current.cursor && !(page?.events || []).length;
    current = next;
    if (!page?.more || stuck) break;
  }
  return current;
}

/** Milliseconds until the next poll: quick while the run works, slower while it waits on the artist or a limit, and
 *  doubling per consecutive failure up to 30 s. */
export function pollDelay(state, failures = 0) {
  const status = state.run?.status;
  const base = status === "waiting_approval" || status === "paused_limit" ? IDLE_POLL_MS : POLL_MS;
  return failures > 0 ? Math.min(MAX_BACKOFF_MS, base * 2 ** failures) : base;
}

function sorted(events) {
  return Object.values(events).sort((left, right) => left.seq - right.seq);
}

function toolStatus(outcome) {
  return outcome === "ok" ? "done" : "error";
}

/**
 * What StudioChat renders for the run:
 * - `timeline`: model text, tool steps, quotes and delivered messages in feed order;
 * - `jobs`: every job the run queued, with its final status once it finished; `waitingOn` lists the ids it waits for;
 * - `quote`: the quote waiting for approval, or null; `paused`, `stopping` and `outcome` describe the run's state;
 * - `queued`: messages sent while the run was busy that it has not read yet.
 */
export function runView(state) {
  const timeline = [];
  const steps = {};
  const jobs = {};
  const delivered = new Set();
  const queuedSeq = {};
  let waitingOn = [];
  let paused = null;
  let stopping = null;
  let outcome = null;
  let finalText = null;
  const step = (index, fields) => {
    if (!steps[index]) {
      steps[index] = { type: "tool", stepIndex: index, status: "running", ...fields };
      timeline.push(steps[index]);
    } else Object.assign(steps[index], fields);
    return steps[index];
  };
  for (const { seq, kind, payload = {}, createdAt } of sorted(state.events)) {
    switch (kind) {
      case "run_started":
      case "resumed":
        paused = null;
        break;
      case "step_started":
        paused = null;
        if (payload.kind === "tool") step(payload.stepIndex, { tool: payload.tool, seq });
        break;
      case "assistant_text":
        timeline.push({ type: "text", seq, stepIndex: payload.stepIndex, text: payload.text, final: Boolean(payload.final) });
        if (payload.final) finalText = payload.text;
        break;
      case "tool_called":
        step(payload.stepIndex, { tool: payload.tool, outcome: payload.outcome, summary: payload.summary || "", status: toolStatus(payload.outcome) });
        break;
      case "quote_required":
        step(payload.stepIndex, {
          tool: payload.tool, status: "quote", quote: { ...payload.quote, stepIndex: payload.stepIndex, tool: payload.tool,
            arguments: payload.arguments || {}, prompt: payload.prompt ?? null, state: "pending", seq },
        });
        break;
      case "quote_approved":
        if (steps[payload.stepIndex]?.quote) steps[payload.stepIndex].quote.state = "approved";
        step(payload.stepIndex, { status: "running" });
        break;
      case "quote_declined":
        if (steps[payload.stepIndex]?.quote) Object.assign(steps[payload.stepIndex].quote, { state: "declined", reason: payload.reason });
        step(payload.stepIndex, { status: "declined" });
        break;
      case "job_queued":
        jobs[payload.generationId] = { ...jobs[payload.generationId], generationId: payload.generationId, kind: payload.kind,
          tool: payload.tool, stepIndex: payload.stepIndex, status: "queued", seq };
        break;
      case "waiting_jobs":
        waitingOn = payload.generationIds || [];
        break;
      case "job_finished":
        jobs[payload.generationId] = { ...jobs[payload.generationId], generationId: payload.generationId, kind: payload.kind, status: payload.status };
        waitingOn = waitingOn.filter((id) => id !== payload.generationId);
        break;
      case "message_queued":
        queuedSeq[payload.inboxId] = seq;
        break;
      case "message_delivered": {
        delivered.add(payload.inboxId);
        const row = state.inbox[payload.inboxId];
        if (row) timeline.push({ type: "message", seq, inboxId: row.id, content: row.content, attachments: row.attachments || [], createdAt });
        break;
      }
      case "paused":
        paused = { reason: payload.reason, resumeAfter: payload.resumeAfter ?? null, seq };
        break;
      case "cancel_requested":
        stopping = { cancelJobs: Boolean(payload.cancelJobs), seq };
        break;
      case "completed":
        outcome = { status: "completed", steps: payload.steps, costCents: payload.costCents, seq };
        break;
      case "failed":
        outcome = { status: "failed", code: payload.code, message: payload.message, seq };
        break;
      case "cancelled":
        outcome = { status: "cancelled", cancelJobs: Boolean(payload.cancelJobs), jobs: payload.jobs || [], seq };
        break;
      default:
        break;
    }
  }
  const run = state.run || {};
  const pendingIds = new Set(state.pending?.ids || []);
  const queued = Object.values(state.inbox).filter((row) => {
    if (delivered.has(row.id) || pendingIds.has(row.id)) return !delivered.has(row.id);
    // Missing from a snapshot that was read after the message was queued: the run has read it.
    const seq = queuedSeq[row.id];
    return !(seq !== undefined && state.pending && seq <= state.pending.reach);
  }).sort((left, right) => (left.createdAt ?? 0) - (right.createdAt ?? 0));
  if (!outcome && isTerminalStatus(run.status)) {
    // The run ended but its final event has not been read yet; the run JSON still says how.
    outcome = run.status === "failed" ? { status: "failed", code: run.error?.code, message: run.error?.message }
      : run.status === "cancelled" ? { status: "cancelled", cancelJobs: Boolean(run.cancelJobs), jobs: [] }
        : { status: "completed", steps: run.stepCount, costCents: run.costCents };
  }
  if (!paused && run.status === "paused_limit") paused = { reason: run.pauseReason, resumeAfter: run.resumeAfter ?? null };
  if (run.status && run.status !== "paused_limit") paused = null;
  if (!stopping && run.cancelRequestedAt && isActiveStatus(run.status)) stopping = { cancelJobs: Boolean(run.cancelJobs) };
  if (!isActiveStatus(run.status)) stopping = null;
  // The feed reads the run before its events, so a quote can arrive while the run JSON still says 'running'.
  const quote = isActiveStatus(run.status) && !stopping
    ? [...timeline].reverse().find((item) => item.quote?.state === "pending")?.quote || null : null;
  return {
    runId: run.id || null, status: run.status || null, active: isActiveStatus(run.status), settled: isSettled(state),
    costCents: run.costCents ?? 0, timeline, jobs: Object.values(jobs).sort((left, right) => (left.seq ?? 0) - (right.seq ?? 0)),
    waitingOn: run.status === "waiting_jobs" ? waitingOn : [], quote, paused, stopping, outcome, finalText, queued,
  };
}

/** Whether approving `costCents` needs the card's second confirmation before the approve request is sent. */
export function needsSecondConfirmation(costCents) {
  return Number(costCents) >= CONFIRM_CENTS;
}

/** The quote card's buttons as a small state machine: 'idle' -> 'confirming' (only at $1.00 or more) -> 'sending'. */
export function quoteCardStep(phase, action, costCents) {
  if (action === "approve") return phase === "idle" && needsSecondConfirmation(costCents) ? "confirming" : "sending";
  if (action === "back") return "idle";
  return phase;
}

export function quoteCost(quote) {
  return quote?.display || dollars(Number(quote?.costCents) || 0);
}

const PAUSE_REASONS = {
  agents_disabled: "Agents were turned off by an admin.",
  disabled: "Agents are turned off for your account.",
  active_runs: "You have too many agent runs in progress.",
  steps: "This run reached its step limit.",
  step_limit: "This run reached its step limit.",
  run_cost: "This run reached its cost limit.",
  cost_limit: "This run reached its cost limit.",
  time_limit: "This run reached its time limit.",
  daily_cap: "You reached your daily agent spending cap.",
  grant_daily_cap: "This agent reached its daily spending cap.",
  global_daily_cap: "Veevee reached its daily agent spending cap.",
  global_concurrency: "Too many agent runs are running right now.",
};

/** The pause reason in plain words. */
export function pauseReasonText(reason) {
  return PAUSE_REASONS[reason] || "The run reached a limit.";
}

/** When a paused run tries again: relative within the hour, else the local time (and date when not today). */
export function resumeText(resumeAfter, now = Date.now()) {
  if (resumeAfter === null || resumeAfter === undefined) return "It continues when you send a message.";
  const wait = resumeAfter - now;
  if (wait <= 60000) return "It tries again in a moment.";
  if (wait < 3600000) {
    const minutes = Math.ceil(wait / 60000);
    return `It tries again in ${minutes} minute${minutes === 1 ? "" : "s"}.`;
  }
  const at = new Date(resumeAfter);
  const time = at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const sameDay = at.toDateString() === new Date(now).toDateString();
  return `It tries again at ${time}${sameDay ? "" : ` on ${at.toLocaleDateString([], { month: "short", day: "numeric" })}`}.`;
}

/** The ended run in plain words. */
export function outcomeText(outcome) {
  if (!outcome) return "";
  if (outcome.status === "failed") return outcome.message || "The run failed.";
  if (outcome.status === "cancelled") {
    if (!outcome.cancelJobs) return "Stopped. Jobs it already queued keep running and land in the library.";
    const count = outcome.jobs.length;
    return count ? `Stopped and cancelled ${count} job${count === 1 ? "" : "s"}.` : "Stopped. No jobs were still running.";
  }
  return "";
}

function storageOrNull(storage) {
  if (storage !== undefined) return storage;
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

/** Saves what this tab has read of the run (its events up to the cursor and the messages it queued), so a reload
 *  resumes polling from the last seq with the same thread. */
export function saveRunState(state, storage) {
  if (!state.run?.id) return;
  const events = [];
  for (let seq = 1; seq <= state.cursor && state.events[seq]; seq += 1) events.push(state.events[seq]);
  try {
    storageOrNull(storage)?.setItem(SAVED_KEY + state.run.id, JSON.stringify({ cursor: events.length, events, inbox: state.inbox }));
  } catch {
    // Private mode or a full quota: a reload then reads the feed from 0, which is idempotent.
  }
}

/** The state saved for `run`, or a fresh one that reads the feed from 0 when nothing usable was saved. */
export function restoreRunState(run, storage) {
  try {
    const saved = JSON.parse(storageOrNull(storage)?.getItem(SAVED_KEY + run.id) || "null");
    const events = {};
    saved.events.forEach((event, index) => {
      if (event?.seq !== index + 1 || typeof event.kind !== "string") throw new Error("gap");
      events[event.seq] = event;
    });
    if (saved.cursor !== saved.events.length) throw new Error("cursor");
    const inbox = saved.inbox && typeof saved.inbox === "object" ? saved.inbox : {};
    return { ...runState(run), events, cursor: saved.cursor, reach: saved.cursor, inbox };
  } catch {
    return runState(run);
  }
}

export function forgetRunState(runId, storage) {
  try {
    storageOrNull(storage)?.removeItem(SAVED_KEY + runId);
  } catch {
    // Nothing to clean up.
  }
}
