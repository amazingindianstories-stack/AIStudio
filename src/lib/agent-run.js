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

/** Takes a newer run JSON (from approve, decline or cancel) without touching the feed. */
export function withRun(state, run) {
  return { ...state, run: newer(state.run, run) };
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

/**
 * What StudioChat renders for the run:
 * - `timeline`: model text, tool steps (with their arguments), quotes and delivered messages in feed order, each with
 *   `at` (when it happened) and `since`/`until` (the items around it), so a trace can say how long the work took;
 * - `jobs`: every job the run queued, with its final status once it finished; `waitingOn` lists the ids it waits for;
 * - `quote`: the quote waiting for approval, or null; `paused`, `stopping` and `outcome` describe the run's state;
 * - `queued`: messages sent while the run was busy that it has not read yet;
 * - `startMessageId`: the persisted user message that started the run, where the thread shows its activity.
 */
export function runView(state) {
  const timeline = [];
  const steps = {};
  const jobs = {};
  const delivered = new Set();
  const queuedSeq = {};
  let waitingOn = [];
  let paused = null;
  let started = false;
  let stopping = null;
  let outcome = null;
  let finalText = null;
  let startMessageId = null;
  const step = (index, fields) => {
    if (!steps[index]) {
      steps[index] = { type: "tool", stepIndex: index, status: "running", ...fields };
      timeline.push(steps[index]);
    } else Object.assign(steps[index], fields);
    return steps[index];
  };
  for (const { seq, kind, payload = {}, createdAt } of sorted(state.events)) {
    switch (kind) {
      case "run_queued":
        startMessageId = payload.messageId ?? null;
        break;
      case "run_started":
      case "resumed":
        paused = null;
        started = true;
        break;
      case "step_started":
        paused = null;
        started = true;
        if (payload.kind === "tool") step(payload.stepIndex, { tool: payload.tool, seq, at: createdAt, ...(payload.arguments ? { arguments: payload.arguments } : {}) });
        break;
      case "assistant_text":
        timeline.push({ type: "text", seq, stepIndex: payload.stepIndex, text: payload.text, final: Boolean(payload.final), at: createdAt });
        if (payload.final) finalText = payload.text;
        break;
      case "tool_called":
        step(payload.stepIndex, { tool: payload.tool, outcome: payload.outcome, summary: payload.summary || "", status: payload.ok ? "done" : "error",
          endedAt: createdAt });
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
        // The text is known only for a message this tab saw queued; the thread shows the saved copy otherwise.
        const row = state.inbox[payload.inboxId];
        timeline.push({ type: "message", seq, inboxId: payload.inboxId, stepIndex: payload.stepIndex, content: row?.content ?? null,
          attachments: row?.attachments || [], createdAt, at: createdAt });
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
        // A job the stop cancelled (or is still cancelling with the provider) no longer runs for this thread.
        for (const entry of payload.jobs || []) {
          const job = jobs[entry?.generationId];
          if (job) job.status = ["succeeded", "failed"].includes(entry.status) ? entry.status : "cancelled";
        }
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
  // Each item's span in the run: from the item before it (the run's start for the first) to the next one (the run's end
  // for the last), so a turn's trace can say how long its work took.
  timeline.forEach((item, index) => {
    item.since = index ? timeline[index - 1].at ?? null : run.startedAt ?? null;
    item.until = timeline[index + 1]?.at ?? (isTerminalStatus(run.status) ? run.finishedAt ?? null : null);
  });
  // A step the run never got back to (a quote left waiting, a call cut off) ended with the run.
  if (outcome) for (const item of Object.values(steps)) if (["quote", "running"].includes(item.status)) item.status = "stopped";
  if (!paused && run.status === "paused_limit") paused = { reason: run.pauseReason, resumeAfter: run.resumeAfter ?? null };
  if (run.status && run.status !== "paused_limit") paused = null;
  if (!stopping && run.cancelRequestedAt && isActiveStatus(run.status)) stopping = { cancelJobs: Boolean(run.cancelJobs) };
  if (!isActiveStatus(run.status)) stopping = null;
  // The feed reads the run before its events, so a quote can arrive while the run JSON still says 'running'.
  const quote = isActiveStatus(run.status) && !stopping
    ? [...timeline].reverse().find((item) => item.quote?.state === "pending")?.quote || null : null;
  return {
    runId: run.id || null, status: run.status || null, model: run.model || null, active: isActiveStatus(run.status), settled: isSettled(state),
    costCents: run.costCents ?? 0, timeline, jobs: Object.values(jobs).sort((left, right) => (left.seq ?? 0) - (right.seq ?? 0)),
    waitingOn: run.status === "waiting_jobs" ? waitingOn : [], quote, paused, stopping, outcome, finalText, queued, startMessageId,
    started: started || Boolean(run.startedAt),
  };
}

// Where a saved message sits in a run: its reply at a step, or a message it read from its inbox before a step.
function savedAnchor(message) {
  if (message.role === "assistant" && message.toolTrace?.runId) return `${message.toolTrace.runId}:reply:${message.toolTrace.stepIndex}`;
  if (message.role === "user" && message.runId) return `${message.runId}:read:${message.deliveredStep}`;
  return null;
}

function feedAnchor(runId, item) {
  if (item.type === "text" && item.final) return `${runId}:reply:${item.stepIndex}`;
  if (item.type === "message") return `${runId}:read:${item.stepIndex}`;
  return null;
}

/**
 * The thread in order: the saved messages, each run's activity right after the message that started it. A run's saved
 * replies and the messages it read from its inbox show as saved messages, so the feed items they repeat are left out
 * and the activity between them is split into segments, each placed after the saved message it follows. The last
 * segment of a run also carries its state (queued messages, quote, pause, status line, how it ended).
 *
 * `runs` is `[{ view, ...fields }]`, oldest first. Entries are `{ message }` or `{ panel: true, key, run, items, last }`
 * (`run` is the runs entry). A run whose start message is not loaded shows at the end when `live`, else not at all.
 */
export function threadEntries(messages, runs) {
  const lastAt = new Map();
  messages.forEach((message, index) => {
    lastAt.set(`start:${message.id}`, index);
    const anchor = savedAnchor(message);
    if (anchor) lastAt.set(anchor, index);
  });
  const placed = new Map();
  const unplaced = [];
  for (const run of runs) {
    const { view } = run;
    const segments = [{ key: `start:${view.startMessageId}`, items: [] }];
    for (const item of view.timeline) {
      const anchor = feedAnchor(view.runId, item);
      if (anchor && lastAt.has(anchor)) {
        if (segments.at(-1).key !== anchor) segments.push({ key: anchor, items: [] });
      } else if (item.type !== "message" || item.content !== null) segments.at(-1).items.push(item);
    }
    segments.forEach((segment, index) => {
      const last = index === segments.length - 1;
      if (!segment.items.length && !last) return;
      const entry = { panel: true, key: `${view.runId}:${segment.key}`, run, items: segment.items, last };
      if (lastAt.has(segment.key)) {
        if (!placed.has(segment.key)) placed.set(segment.key, []);
        placed.get(segment.key).push(entry);
      } else if (run.live) unplaced.push(entry);
    });
  }
  const thread = [];
  messages.forEach((message, index) => {
    thread.push({ message });
    for (const key of [`start:${message.id}`, savedAnchor(message)]) {
      if (key && lastAt.get(key) === index) thread.push(...(placed.get(key) || []));
    }
  });
  return [...thread, ...unplaced];
}

/**
 * A panel segment's items as the thread shows them: each run of the model's working notes (text it sent before its
 * reply) and tool steps folds into one trace, `{ type: 'trace', key, items }`, which the panel shows collapsed. Replies
 * and messages stay in the thread as they are.
 */
export function traceGroups(items) {
  const groups = [];
  let trace = null;
  for (const item of items) {
    if (item.type === "tool" || (item.type === "text" && !item.final)) {
      if (!trace) groups.push(trace = { type: "trace", key: `trace-${item.seq}`, items: [] });
      trace.items.push(item);
    } else {
      trace = null;
      groups.push(item);
    }
  }
  return groups;
}

/** `ms` as "8s", "2m 5s" or "1h 3m". */
export function durationText(ms) {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return seconds % 60 ? `${minutes}m ${seconds % 60}s` : `${minutes}m`;
  return minutes % 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${Math.floor(minutes / 60)}h`;
}

/** A trace's collapsed line: "Worked for 12s · 3 steps · 1 failed", or "Working · 2 steps" while it is the run's
 *  current work (`live`). The time runs from before its first item to the reply or next message after its last. */
export function traceSummary(trace, { live = false } = {}) {
  const tools = trace.items.filter((item) => item.type === "tool");
  const failed = tools.filter((item) => item.status === "error").length;
  const since = trace.items[0]?.since;
  const until = trace.items.at(-1)?.until;
  const timed = !live && Number.isFinite(since) && Number.isFinite(until) && until >= since;
  return [
    live ? "Working" : timed ? `Worked for ${durationText(until - since)}` : "Worked",
    tools.length ? `${tools.length} step${tools.length === 1 ? "" : "s"}` : null,
    failed ? `${failed} failed` : null,
  ].filter(Boolean).join(" · ");
}

/** A tool step's arguments for its trace row: the prompt on its own, the rest as labelled values (lists joined, objects
 *  as compact JSON), without call plumbing. */
export function traceArguments(args) {
  const rows = [];
  let prompt = null;
  for (const [key, value] of Object.entries(args || {})) {
    if (value === null || value === undefined || value === "") continue;
    if (key === "prompt" && typeof value === "string") prompt = value;
    else if (!HIDDEN_ARGUMENTS.has(key)) {
      const shown = Array.isArray(value) ? value.map((entry) => (entry && typeof entry === "object" ? JSON.stringify(entry) : String(entry))).join(", ")
        : value && typeof value === "object" ? JSON.stringify(value) : argumentValue(key, value);
      rows.push({ key, label: ARGUMENT_LABELS[key] || sentenceCase(key), value: shown });
    }
  }
  return { prompt, rows: rows.sort(byArgumentOrder) };
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

/** "some_tool", "someKey" or "SOME_CODE" in sentence case: "Some tool", "Some key", "Some code". */
export function sentenceCase(name) {
  const words = String(name ?? "").replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The line under an active run: what it is doing, and whether that is work (a spinner), a pause or a wait on the artist. */
export function statusLine(view) {
  if (view.stopping) return { label: "Stopping…", icon: "spin" };
  if (view.status === "waiting_approval") return { label: "Waiting for your approval", icon: "clock" };
  if (view.status === "paused_limit") return { label: "Paused", icon: "pause" };
  if (view.status === "waiting_jobs") {
    const count = view.waitingOn?.length || 0;
    return { label: `Waiting for ${count || "its"} job${count === 1 ? "" : "s"} to finish`, icon: "spin" };
  }
  // The run JSON can still say 'queued' after its events show it started; the events win.
  return { label: view.status === "queued" && !view.started ? "Starting…" : "Working…", icon: "spin" };
}

/** The note under a message queued into the active run: a stopping run never reads it, so it joins the chat once the run stops. */
export function queuedNote(view) {
  return view.stopping ? "Queued. It is added to the chat once the run stops." : "Queued. The agent reads it after its current step.";
}

const STEP_STATUS = { running: "Running", done: "Done", error: "Failed", declined: "Declined", quote: "Waiting for approval",
  stopped: "Stopped" };

const STEP_OUTCOMES = {
  INVALID_INPUT: "the request was not valid",
  MODEL_UNAVAILABLE: "the model is not available",
  NOT_FOUND: "not found",
  BUDGET_EXCEEDED: "refused by a limit",
  RATE_LIMITED: "refused by a limit",
  CONCURRENCY_LIMIT: "refused by a limit",
  PAID_BUDGET_HOLD: "refused by a limit",
  COST_LIMIT: "refused by a limit",
  MAINTENANCE: "Veevee is being updated",
  MCP_DISABLED: "agent changes are switched off",
  IDEMPOTENCY_CONFLICT: "it conflicted with an earlier call",
  VERSION_CONFLICT: "it changed in the meantime",
  INSUFFICIENT_SCOPE: "not allowed",
  FORBIDDEN: "not allowed",
  UNKNOWN_TOOL: "this tool cannot be used here",
  DESIGN_FAILED: "the prompt could not be designed",
  INTERNAL_ERROR: "something went wrong in Veevee",
};

/** A tool step's status in plain words: "Done", "Failed", or "Failed: refused by a limit" for a specific outcome. */
export function stepStatusText(step) {
  if (step.status !== "error") return STEP_STATUS[step.status] || "Running";
  const outcome = step.outcome;
  if (!outcome || outcome === "error") return "Failed";
  return `Failed: ${STEP_OUTCOMES[outcome] || sentenceCase(outcome).toLowerCase()}`;
}

const ARGUMENT_LABELS = {
  model: "Model",
  aspectRatio: "Aspect ratio",
  duration: "Duration",
  durationSeconds: "Duration",
  resolution: "Resolution",
  count: "Count",
  outputs: "Count",
  seed: "Seed",
  mode: "Mode",
  generateAudio: "Audio",
  draft: "Draft",
  bitrateMode: "Bitrate",
  quality: "Quality",
};
const ARGUMENT_ORDER = Object.keys(ARGUMENT_LABELS);
// Stored arguments come back from jsonb with their keys sorted by length, so rows follow the labels' order (known keys
// first), then the rest by name.
function byArgumentOrder(a, b) {
  const rank = (key) => (ARGUMENT_ORDER.includes(key) ? ARGUMENT_ORDER.indexOf(key) : ARGUMENT_ORDER.length);
  return rank(a.key) - rank(b.key) || (rank(a.key) === ARGUMENT_ORDER.length ? a.key.localeCompare(b.key) : 0);
}
// Call plumbing the model may pass that says nothing about what the artist pays for.
const HIDDEN_ARGUMENTS = new Set(["prompt", "wait", "maxWaitSeconds", "includePreview", "quoteToken", "idempotencyKey", "confirmedByUser"]);

function argumentValue(key, value) {
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (key === "duration" || key === "durationSeconds") return `${value}s`;
  return String(value);
}

/** The quote card's argument rows: human labels and values with units, without the prompt or call plumbing. */
export function quoteDetails(args) {
  return Object.entries(args || {})
    .filter(([key, value]) => !HIDDEN_ARGUMENTS.has(key) && value !== null && value !== undefined && typeof value !== "object")
    .map(([key, value]) => ({ key, label: ARGUMENT_LABELS[key] || sentenceCase(key), value: argumentValue(key, value) }))
    .sort(byArgumentOrder);
}

const ACTION_ERRORS = {
  NO_PENDING_QUOTE: "This quote is no longer waiting for approval.",
  RUN_FINISHED: "This run has already finished.",
};

/**
 * POSTs one run action ('approve', 'decline' or 'cancel') and resolves to `{ ok, run, code, error }`. A 409 that only
 * says the run moved on (NO_PENDING_QUOTE, RUN_FINISHED) comes back as `ok: false` with a plain message, never a throw.
 */
export async function runAction(conversationId, runId, action, body, fetchImpl = fetch) {
  try {
    const response = await fetchImpl(`/api/agent-conversations/${conversationId}/runs/${runId}/${action}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (response.ok && data.run) return { ok: true, run: data.run, code: null, error: null };
    return { ok: false, run: null, code: data.code || null, error: ACTION_ERRORS[data.code] || data.error || "That did not work. Try again." };
  } catch {
    return { ok: false, run: null, code: null, error: "Veevee could not be reached. Try again." };
  }
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
