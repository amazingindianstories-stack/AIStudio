import test from "node:test";
import assert from "node:assert/strict";
import {
  addQueuedMessage, applyPage, drainFeed, forgetRunState, isSettled, needsSecondConfirmation, outcomeText, pauseReasonText,
  pollDelay, queuedNote, quoteCardStep, quoteCost, quoteDetails, restoreRunState, resumeText, runAction, runState, runView, saveRunState,
  sentenceCase, statusLine, stepStatusText, threadEntries, withRun,
} from "./agent-run.js";

const RUN = { id: "run-1", conversationId: "c-1", status: "running", costCents: 0, stepCount: 0, cancelRequestedAt: null, cancelJobs: false,
  pauseReason: null, resumeAfter: null, error: null, updatedAt: 10 };
const run = (fields = {}) => ({ ...RUN, ...fields });
const event = (seq, kind, payload = {}) => ({ seq, kind, payload, createdAt: 1000 + seq });
const page = (events, fields = {}) => ({ run: run(), events, nextAfter: events.length ? events[events.length - 1].seq : 0,
  more: false, pendingMessages: [], ...fields });

function memoryStorage() {
  const values = new Map();
  return { getItem: (key) => (values.has(key) ? values.get(key) : null), setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key), values };
}

const QUOTE = { costCents: 240, display: "$2.40", expiresAt: 5000, summary: "1 video, 5 s", requiresUserConfirmation: true };

// A run that does everything once: text, a free tool, a quote approved and replayed, a job waited on, the final reply.
const FULL = [
  event(1, "run_queued", { messageId: "m-1" }),
  event(2, "run_started"),
  event(3, "step_started", { stepIndex: 0, kind: "llm" }),
  event(4, "assistant_text", { stepIndex: 0, text: "Let me look.", final: false }),
  event(5, "step_started", { stepIndex: 1, kind: "tool", tool: "search_generations" }),
  event(6, "tool_called", { stepIndex: 1, tool: "search_generations", outcome: "ok", ok: true, summary: "Found 3 items." }),
  event(7, "step_started", { stepIndex: 2, kind: "tool", tool: "generate_video" }),
  event(8, "quote_required", { stepIndex: 2, tool: "generate_video", arguments: { prompt: "A fox", duration: 5 }, prompt: "A fox", quote: QUOTE }),
  event(9, "quote_approved", { stepIndex: 2, costCents: 240 }),
  event(10, "resumed"),
  event(11, "job_queued", { generationId: "g-1", kind: "video", tool: "generate_video", stepIndex: 2 }),
  event(12, "tool_called", { stepIndex: 2, tool: "generate_video", outcome: "running", ok: true, summary: "Queued unsorted_0016." }),
  event(13, "waiting_jobs", { generationIds: ["g-1"] }),
  event(14, "resumed"),
  event(15, "step_started", { stepIndex: 3, kind: "llm" }),
  event(16, "job_finished", { generationId: "g-1", kind: "video", status: "succeeded", stepIndex: 3 }),
  event(17, "assistant_text", { stepIndex: 3, text: "Your fox video is ready.", final: true }),
  event(18, "completed", { steps: 4, costCents: 240 }),
];

test("every event kind folds into the timeline, jobs and outcome", () => {
  const state = applyPage(runState(run()), page(FULL, { run: run({ status: "completed", costCents: 240, updatedAt: 99 }) }));
  const view = runView(state);
  assert.equal(view.status, "completed");
  assert.equal(view.active, false);
  assert.equal(view.settled, true);
  assert.deepEqual(view.timeline.map((item) => [item.type, item.stepIndex, item.status ?? item.text]), [
    ["text", 0, "Let me look."],
    ["tool", 1, "done"],
    ["tool", 2, "done"],
    ["text", 3, "Your fox video is ready."],
  ]);
  assert.equal(view.timeline[1].summary, "Found 3 items.");
  assert.equal(view.timeline[2].quote.state, "approved");
  assert.deepEqual(view.jobs, [{ generationId: "g-1", kind: "video", tool: "generate_video", stepIndex: 2, status: "succeeded", seq: 11 }]);
  assert.equal(view.finalText, "Your fox video is ready.");
  assert.deepEqual(view.outcome, { status: "completed", steps: 4, costCents: 240, seq: 18 });
  assert.equal(view.quote, null);
  assert.equal(view.paused, null);
  assert.equal(view.stopping, null);
  assert.equal(outcomeText(view.outcome), "");
  assert.equal(view.startMessageId, "m-1", "the thread places the run after the message that started it");
});

test("a tool error shows as an error step with its summary", () => {
  const view = runView(applyPage(runState(run()), page([
    event(1, "step_started", { stepIndex: 0, kind: "tool", tool: "generate_image" }),
    event(2, "tool_called", { stepIndex: 0, tool: "generate_image", outcome: "INSUFFICIENT_CREDITS", ok: false, summary: "Not enough credits." }),
  ])));
  assert.deepEqual(view.timeline, [{ type: "tool", stepIndex: 0, status: "error", tool: "generate_image", seq: 1,
    outcome: "INSUFFICIENT_CREDITS", summary: "Not enough credits." }]);
});

test("waiting_jobs lists the jobs still running until each finishes", () => {
  let state = applyPage(runState(run()), page([
    event(1, "job_queued", { generationId: "g-1", kind: "image", tool: "generate_image", stepIndex: 1 }),
    event(2, "job_queued", { generationId: "g-2", kind: "image", tool: "generate_image", stepIndex: 1 }),
    event(3, "waiting_jobs", { generationIds: ["g-1", "g-2"] }),
  ], { run: run({ status: "waiting_jobs" }) }));
  assert.deepEqual(runView(state).waitingOn, ["g-1", "g-2"]);
  state = applyPage(state, page([event(4, "job_finished", { generationId: "g-1", kind: "image", status: "failed", stepIndex: 2 })],
    { run: run({ status: "waiting_jobs", updatedAt: 20 }) }));
  const view = runView(state);
  assert.deepEqual(view.waitingOn, ["g-2"]);
  assert.deepEqual(view.jobs.map((job) => [job.generationId, job.status]), [["g-1", "failed"], ["g-2", "queued"]]);
});

test("duplicate and out-of-order pages change nothing and the cursor never skips a gap", () => {
  const first = page(FULL.slice(0, 6), { more: true });
  const second = page(FULL.slice(6, 12), { more: true });
  const third = page(FULL.slice(12), { run: run({ status: "completed", updatedAt: 99 }) });
  const inOrder = [first, second, third].reduce(applyPage, runState(run()));

  let shuffled = applyPage(runState(run()), third);
  assert.equal(shuffled.cursor, 0, "events past a gap do not move the cursor");
  assert.equal(shuffled.more, true, "a gap below the newest page keeps the drain going");
  assert.equal(isSettled(shuffled), false);
  shuffled = applyPage(shuffled, first);
  assert.equal(shuffled.cursor, 6);
  shuffled = [second, first, third, second].reduce(applyPage, shuffled);
  assert.equal(shuffled.cursor, 18);
  assert.deepEqual(runView(shuffled), runView(inOrder));
  assert.equal(isSettled(shuffled), true);

  const replayed = applyPage(inOrder, page(FULL, { run: run({ status: "running", updatedAt: 5 }) }));
  assert.deepEqual(runView(replayed), runView(inOrder), "a stale page neither duplicates events nor rewinds the run");
});

test("an older page answering late does not end a drain the newer page kept open", () => {
  let state = applyPage(runState(run()), page(FULL.slice(0, 6), { more: true }));
  state = applyPage(state, page(FULL.slice(0, 3), { more: false }));
  assert.equal(state.more, true);
});

test("drainFeed follows more page by page from the cursor", async () => {
  const asked = [];
  const fetchPage = async (after) => {
    asked.push(after);
    const rows = FULL.filter((row) => row.seq > after).slice(0, 5);
    const done = after + rows.length >= FULL.length;
    return page(rows, { nextAfter: rows.length ? rows[rows.length - 1].seq : after, more: !done,
      run: run({ status: "completed", updatedAt: 99 }) });
  };
  const state = await drainFeed(runState(run()), fetchPage);
  assert.deepEqual(asked, [0, 5, 10, 15]);
  assert.equal(state.cursor, 18);
  assert.equal(isSettled(state), true);
});

test("drainFeed stops at maxPages and when a page makes no progress", async () => {
  let calls = 0;
  const endless = async (after) => {
    calls += 1;
    return page([event(after + 1, "resumed")], { more: true });
  };
  assert.equal((await drainFeed(runState(run()), endless, { maxPages: 3 })).cursor, 3);
  assert.equal(calls, 3);
  calls = 0;
  const empty = async () => {
    calls += 1;
    return page([], { more: true });
  };
  await drainFeed(runState(run()), empty);
  assert.equal(calls, 1);
});

test("a page for another run is ignored", () => {
  const state = runState(run());
  assert.equal(applyPage(state, page(FULL, { run: run({ id: "run-2" }) })), state);
});

test("a message sent during a run shows as queued until message_delivered", () => {
  const inbox = { id: "i-1", runId: "run-1", content: "Make it blue", attachments: [], createdAt: 50, deliveredAt: null };
  let state = applyPage(runState(run()), page(FULL.slice(0, 4)));
  state = addQueuedMessage(state, inbox, run({ updatedAt: 11 }));
  assert.deepEqual(runView(state).queued.map((row) => row.content), ["Make it blue"]);

  // A poll issued before the message was queued has no message_queued event yet, so its snapshot cannot drop it.
  state = applyPage(state, page([], { nextAfter: 4 }));
  assert.equal(runView(state).queued.length, 1);

  state = applyPage(state, page([event(5, "message_queued", { inboxId: "i-1" })], { pendingMessages: [inbox] }));
  assert.equal(runView(state).queued.length, 1);

  state = applyPage(state, page([event(6, "step_started", { stepIndex: 1, kind: "llm" }),
    event(7, "message_delivered", { inboxId: "i-1", stepIndex: 1 })], { pendingMessages: [inbox] }));
  const view = runView(state);
  assert.deepEqual(view.queued, []);
  assert.deepEqual(view.timeline.at(-1), { type: "message", seq: 7, inboxId: "i-1", stepIndex: 1, content: "Make it blue", attachments: [],
    createdAt: 1007 });
});

test("a message queued into a stopping run says it joins the chat once the run stops", () => {
  const inbox = { id: "i-1", runId: "run-1", content: "Make it blue", attachments: [], createdAt: 50, deliveredAt: null };
  let state = addQueuedMessage(applyPage(runState(run()), page([event(1, "run_started")])), inbox, run({ updatedAt: 11 }));
  assert.equal(queuedNote(runView(state)), "Queued. The agent reads it after its current step.");
  state = applyPage(state, page([event(2, "cancel_requested", { cancelJobs: false }), event(3, "message_queued", { inboxId: "i-1" })],
    { run: run({ cancelRequestedAt: 70, updatedAt: 70 }), pendingMessages: [inbox] }));
  const view = runView(state);
  assert.deepEqual(view.queued.map((row) => row.content), ["Make it blue"]);
  assert.equal(queuedNote(view), "Queued. It is added to the chat once the run stops.");
  // The run JSON alone (a reload before the cancel event is read) also marks it stopping.
  assert.equal(queuedNote(runView(runState(run({ cancelRequestedAt: 70 })))), "Queued. It is added to the chat once the run stops.");
});

test("a queued message the snapshot no longer lists has been read even before message_delivered is seen", () => {
  const inbox = { id: "i-1", runId: "run-1", content: "Also a cat", attachments: [{ id: "u-1", kind: "document", name: "brief.pdf" }], createdAt: 50 };
  let state = applyPage(runState(run()), page([event(1, "message_queued", { inboxId: "i-1" })], { pendingMessages: [inbox] }));
  assert.deepEqual(runView(state).queued[0].attachments, inbox.attachments);
  state = applyPage(state, page([], { nextAfter: 1, pendingMessages: [] }));
  assert.deepEqual(runView(state).queued, []);
});

test("a pending quote shows until it is approved or declined", () => {
  const required = event(1, "quote_required", { stepIndex: 2, tool: "generate_video", arguments: { prompt: "A fox" }, prompt: "A fox", quote: QUOTE });
  let state = applyPage(runState(run()), page([required], { run: run({ status: "running" }) }));
  const quote = runView(state).quote;
  assert.deepEqual(quote, { ...QUOTE, stepIndex: 2, tool: "generate_video", arguments: { prompt: "A fox" }, prompt: "A fox", state: "pending", seq: 1 },
    "the quote shows even when the run JSON was read just before it");
  assert.equal(quoteCost(quote), "$2.40");
  assert.equal(quoteCost({ costCents: 125 }), "$1.25");

  const declined = applyPage(state, page([event(2, "quote_declined", { stepIndex: 2, reason: "declined" })], { run: run({ status: "queued", updatedAt: 20 }) }));
  assert.equal(runView(declined).quote, null);
  assert.deepEqual([runView(declined).timeline[0].status, runView(declined).timeline[0].quote.state, runView(declined).timeline[0].quote.reason],
    ["declined", "declined", "declined"]);

  state = applyPage(state, page([event(2, "quote_approved", { stepIndex: 2, costCents: 240 })], { run: run({ status: "queued", updatedAt: 20 }) }));
  assert.equal(runView(state).quote, null);
  assert.equal(runView(state).timeline[0].quote.state, "approved");
  assert.equal(runView(state).timeline[0].status, "running");
});

test("a stop request hides the pending quote", () => {
  const state = applyPage(runState(run()), page([
    event(1, "quote_required", { stepIndex: 0, tool: "generate_image", arguments: {}, quote: QUOTE }),
    event(2, "cancel_requested", { cancelJobs: false }),
  ], { run: run({ status: "waiting_approval", cancelRequestedAt: 90 }) }));
  assert.equal(runView(state).quote, null);
  assert.deepEqual(runView(state).stopping, { cancelJobs: false, seq: 2 });
});

test("approving $1.00 or more needs a second confirmation; less goes straight to sending", () => {
  assert.equal(needsSecondConfirmation(99), false);
  assert.equal(needsSecondConfirmation(100), true);
  assert.equal(quoteCardStep("idle", "approve", 99), "sending");
  assert.equal(quoteCardStep("idle", "approve", 100), "confirming");
  assert.equal(quoteCardStep("confirming", "approve", 100), "sending");
  assert.equal(quoteCardStep("confirming", "back", 100), "idle");
  assert.equal(quoteCardStep("sending", "other", 100), "sending");
});

test("a paused run says why in plain words and when it tries again", () => {
  const now = new Date(2026, 10, 4, 9, 0).getTime();
  let state = applyPage(runState(run()), page([event(1, "paused", { reason: "daily_cap", resumeAfter: now + 30 * 60000 })],
    { run: run({ status: "paused_limit", pauseReason: "daily_cap", resumeAfter: now + 30 * 60000 }) }));
  const view = runView(state);
  assert.deepEqual(view.paused, { reason: "daily_cap", resumeAfter: now + 30 * 60000, seq: 1 });
  assert.equal(pauseReasonText(view.paused.reason), "You reached your daily agent spending cap.");
  assert.equal(resumeText(view.paused.resumeAfter, now), "It tries again in 30 minutes.");
  assert.equal(resumeText(now + 60000, now), "It tries again in a moment.");
  assert.equal(resumeText(now + 61000, now), "It tries again in 2 minutes.");
  assert.equal(resumeText(null, now), "It continues when you send a message.");
  const later = new Date(2026, 10, 4, 15, 30).getTime();
  assert.equal(resumeText(later, now), `It tries again at ${new Date(later).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.`);
  const tomorrow = new Date(2026, 10, 5, 8, 0).getTime();
  assert.match(resumeText(tomorrow, now), / on Nov 5\.$/);
  for (const reason of ["agents_disabled", "step_limit", "cost_limit", "time_limit", "global_concurrency"]) {
    assert.notEqual(pauseReasonText(reason), "The run reached a limit.", reason);
  }
  assert.equal(pauseReasonText("something_new"), "The run reached a limit.");

  state = applyPage(state, page([event(2, "resumed")], { run: run({ status: "running", updatedAt: 20 }) }));
  assert.equal(runView(state).paused, null);
});

test("failed and cancelled runs explain themselves", () => {
  const failed = runView(applyPage(runState(run()), page([event(1, "failed", { code: "llm_failed", message: "The model could not answer." })],
    { run: run({ status: "failed", error: { code: "llm_failed", message: "The model could not answer." } }) })));
  assert.deepEqual(failed.outcome, { status: "failed", code: "llm_failed", message: "The model could not answer.", seq: 1 });
  assert.equal(outcomeText(failed.outcome), "The model could not answer.");

  const kept = runView(applyPage(runState(run()), page([event(1, "cancel_requested", { cancelJobs: false }), event(2, "cancelled", { cancelJobs: false, jobs: [] })],
    { run: run({ status: "cancelled", cancelRequestedAt: 5 }) })));
  assert.equal(kept.stopping, null, "a finished run is no longer stopping");
  assert.equal(outcomeText(kept.outcome), "Stopped. Jobs it already queued keep running and land in the library.");

  const jobs = [{ generationId: "g-1", status: "cancelled", message: "Cancelled." }, { generationId: "g-2", status: "cancelled", message: "Cancelled." }];
  const cancelled = runView(applyPage(runState(run()), page([event(1, "cancelled", { cancelJobs: true, jobs })], { run: run({ status: "cancelled" }) })));
  assert.equal(outcomeText(cancelled.outcome), "Stopped and cancelled 2 jobs.");

  // The jobs a stop cancelled stop showing as running: a deferred provider cancel (still 'running') counts as cancelled.
  const queued = [1, 2, 3].map((index) => event(index, "job_queued", { generationId: `g-${index}`, kind: "image", tool: "generate_image", stepIndex: index }));
  const stopped = runView(applyPage(runState(run()), page([...queued, event(4, "cancelled", { cancelJobs: true, jobs: [
    { generationId: "g-1", status: "cancelled", message: null },
    { generationId: "g-2", status: "running", message: "Cancellation is being reconciled with the provider." },
    { generationId: "g-9", status: "cancelled", message: null },
  ] })], { run: run({ status: "cancelled" }) })));
  assert.deepEqual(stopped.jobs.map((job) => [job.generationId, job.status]), [["g-1", "cancelled"], ["g-2", "cancelled"], ["g-3", "queued"]]);
  assert.equal(outcomeText({ status: "cancelled", cancelJobs: true, jobs: [] }), "Stopped. No jobs were still running.");

  const unread = runView(runState(run({ status: "failed", error: { code: "grant_invalid", message: "Access was revoked." } })));
  assert.equal(outcomeText(unread.outcome), "Access was revoked.", "the run JSON explains an end whose event is not read yet");
});

test("a step the run never got back to reads Stopped once the run ends, not waiting or running", () => {
  const started = [
    event(1, "step_started", { stepIndex: 0, kind: "tool", tool: "generate_video" }),
    event(2, "quote_required", { stepIndex: 0, tool: "generate_video", arguments: { prompt: "A fox" }, prompt: "A fox", quote: QUOTE }),
    event(3, "step_started", { stepIndex: 1, kind: "tool", tool: "search_generations" }),
  ];
  const waiting = runView(applyPage(runState(run()), page(started, { run: run({ status: "waiting_approval" }) })));
  assert.deepEqual(waiting.timeline.map((item) => stepStatusText(item)), ["Waiting for approval", "Running"]);

  for (const [ending, status] of [[event(4, "cancelled", { cancelJobs: false, jobs: [] }), "cancelled"],
    [event(4, "failed", { code: "llm_failed", message: "The model could not answer." }), "failed"]]) {
    const view = runView(applyPage(runState(run()), page([...started, ending], { run: run({ status }) })));
    assert.deepEqual(view.timeline.map((item) => [item.status, stepStatusText(item)]), [["stopped", "Stopped"], ["stopped", "Stopped"]], status);
    assert.equal(view.quote, null);
  }
});

test("Stop and Stop and cancel jobs show a stopping state until the run ends", () => {
  let state = applyPage(runState(run()), page([event(1, "run_started")]));
  assert.equal(runView(state).stopping, null);
  state = applyPage(state, page([event(2, "cancel_requested", { cancelJobs: true })], { run: run({ cancelRequestedAt: 70, cancelJobs: true, updatedAt: 70 }) }));
  assert.deepEqual(runView(state).stopping, { cancelJobs: true, seq: 2 });
  const unread = runView(runState(run({ cancelRequestedAt: 70 })));
  assert.deepEqual(unread.stopping, { cancelJobs: false }, "the run JSON shows a stop whose event is not read yet");
});

test("polling is quick while working, slower while waiting, and backs off on errors", () => {
  assert.equal(pollDelay(runState(run())), 1500);
  assert.equal(pollDelay(runState(run({ status: "waiting_approval" }))), 5000);
  assert.equal(pollDelay(runState(run({ status: "paused_limit" }))), 5000);
  assert.equal(pollDelay(runState(run()), 1), 3000);
  assert.equal(pollDelay(runState(run()), 3), 12000);
  assert.equal(pollDelay(runState(run()), 10), 30000);
});

test("a reload resumes from the last seq with the same thread", async () => {
  const storage = memoryStorage();
  const inbox = { id: "i-1", runId: "run-1", content: "Make it blue", attachments: [], createdAt: 50 };
  let state = applyPage(runState(run()), page([...FULL.slice(0, 6), event(7, "message_queued", { inboxId: "i-1" })], { pendingMessages: [inbox] }));
  saveRunState(state, storage);

  const asked = [];
  let restored = restoreRunState(run({ updatedAt: 30 }), storage);
  assert.equal(restored.cursor, 7);
  restored = await drainFeed(restored, async (after) => {
    asked.push(after);
    return page([event(8, "message_delivered", { inboxId: "i-1", stepIndex: 2 })], { run: run({ updatedAt: 40 }) });
  });
  assert.deepEqual(asked, [7]);
  const view = runView(restored);
  assert.deepEqual(view.timeline.map((item) => item.type), ["text", "tool", "message"]);
  assert.equal(view.timeline.at(-1).content, "Make it blue", "the delivered message keeps the text saved before the reload");

  forgetRunState("run-1", storage);
  assert.equal(storage.values.size, 0);
  assert.equal(restoreRunState(run(), storage).cursor, 0);
});

test("a damaged or missing save reads the feed from 0 again, which is idempotent", () => {
  const storage = memoryStorage();
  storage.setItem("veevee.agentRun.run-1", JSON.stringify({ cursor: 3, events: [event(1, "run_started"), event(3, "resumed")], inbox: {} }));
  assert.equal(restoreRunState(run(), storage).cursor, 0);
  storage.setItem("veevee.agentRun.run-1", "{not json");
  assert.equal(restoreRunState(run(), storage).cursor, 0);
  const throwing = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("quota"); }, removeItem() { throw new Error("denied"); } };
  assert.equal(restoreRunState(run(), throwing).cursor, 0);
  saveRunState(applyPage(runState(run()), page(FULL)), throwing);
  forgetRunState("run-1", throwing);
  assert.equal(restoreRunState(run(), null).cursor, 0);

  const once = applyPage(runState(run()), page(FULL));
  assert.deepEqual(runView(applyPage(once, page(FULL))), runView(once));
});

test("withRun takes a newer run from approve, decline or cancel without touching the feed", () => {
  const state = applyPage(runState(run()), page(FULL.slice(0, 8), { run: run({ status: "waiting_approval", updatedAt: 20 }) }));
  const approved = withRun(state, run({ status: "running", updatedAt: 30 }));
  assert.equal(approved.run.status, "running");
  assert.equal(approved.cursor, state.cursor);
  assert.equal(approved.events, state.events);
  assert.equal(withRun(state, run({ status: "running", updatedAt: 5 })).run.status, "waiting_approval", "an older run JSON loses");
  assert.equal(withRun(state, run({ id: "run-2", updatedAt: 99 })).run.id, "run-1", "another run's JSON is ignored");
});

function fakeFetch(status, data) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, body: JSON.parse(init.body) });
    return { ok: status >= 200 && status < 300, status, json: async () => data };
  };
  return { calls, fetchImpl };
}

test("runAction posts exactly the body each action takes", async () => {
  const approve = fakeFetch(200, { run: run({ status: "running", updatedAt: 30 }) });
  const result = await runAction("c-1", "run-1", "approve", { stepIndex: 2 }, approve.fetchImpl);
  assert.deepEqual(approve.calls, [{ url: "/api/agent-conversations/c-1/runs/run-1/approve", method: "POST", body: { stepIndex: 2 } }]);
  assert.deepEqual(result, { ok: true, run: run({ status: "running", updatedAt: 30 }), code: null, error: null });

  const stop = fakeFetch(202, { run: run({ cancelRequestedAt: 40, cancelJobs: true, updatedAt: 40 }) });
  assert.equal((await runAction("c-1", "run-1", "cancel", { cancelJobs: true }, stop.fetchImpl)).ok, true);
  assert.deepEqual(stop.calls[0].body, { cancelJobs: true });
  assert.equal(stop.calls[0].url, "/api/agent-conversations/c-1/runs/run-1/cancel");
});

test("runAction turns a quote or run that moved on into a plain message", async () => {
  const gone = fakeFetch(409, { error: "No quote is waiting for approval at this step.", code: "NO_PENDING_QUOTE" });
  assert.deepEqual(await runAction("c-1", "run-1", "decline", { stepIndex: 2 }, gone.fetchImpl),
    { ok: false, run: null, code: "NO_PENDING_QUOTE", error: "This quote is no longer waiting for approval." });
  const finished = fakeFetch(409, { error: "This run has already finished.", code: "RUN_FINISHED" });
  assert.deepEqual(await runAction("c-1", "run-1", "cancel", { cancelJobs: false }, finished.fetchImpl),
    { ok: false, run: null, code: "RUN_FINISHED", error: "This run has already finished." });
  const disabled = fakeFetch(403, { error: "Agents are turned off for your account.", code: "AGENTS_DISABLED" });
  assert.equal((await runAction("c-1", "run-1", "approve", { stepIndex: 2 }, disabled.fetchImpl)).error, "Agents are turned off for your account.");
  const offline = await runAction("c-1", "run-1", "approve", { stepIndex: 2 }, async () => { throw new TypeError("offline"); });
  assert.deepEqual(offline, { ok: false, run: null, code: null, error: "Veevee could not be reached. Try again." });
});

test("statusLine spins only while the run works; a pause and a wait on the artist hold still", () => {
  const line = (status, fields = {}) => statusLine({ status, waitingOn: [], stopping: null, ...fields });
  for (const status of ["queued", "running", "waiting_jobs"]) assert.equal(line(status).icon, "spin", status);
  assert.deepEqual(line("queued"), { label: "Starting…", icon: "spin" });
  assert.deepEqual(line("running"), { label: "Working…", icon: "spin" });
  assert.deepEqual(line("waiting_jobs", { waitingOn: ["g-1"] }), { label: "Waiting for 1 job to finish", icon: "spin" });
  assert.equal(line("waiting_jobs", { waitingOn: ["g-1", "g-2"] }).label, "Waiting for 2 jobs to finish");
  assert.equal(line("waiting_jobs").label, "Waiting for its jobs to finish");
  assert.deepEqual(line("paused_limit"), { label: "Paused", icon: "pause" });
  assert.deepEqual(line("waiting_approval"), { label: "Waiting for your approval", icon: "clock" });
  assert.deepEqual(line("waiting_approval", { stopping: { cancelJobs: false } }), { label: "Stopping…", icon: "spin" });
});

test("stepStatusText says Failed for a generic error and names a specific outcome in plain words", () => {
  assert.equal(stepStatusText({ status: "error", outcome: "error" }), "Failed");
  assert.equal(stepStatusText({ status: "error" }), "Failed");
  assert.equal(stepStatusText({ status: "error", outcome: "COST_LIMIT" }), "Failed: refused by a limit");
  assert.equal(stepStatusText({ status: "error", outcome: "RATE_LIMITED" }), "Failed: refused by a limit");
  assert.equal(stepStatusText({ status: "error", outcome: "INVALID_INPUT" }), "Failed: the request was not valid");
  assert.equal(stepStatusText({ status: "error", outcome: "SOMETHING_NEW" }), "Failed: something new");
  assert.equal(stepStatusText({ status: "done", outcome: "ok" }), "Done");
  assert.equal(stepStatusText({ status: "quote" }), "Waiting for approval");
  assert.equal(stepStatusText({ status: "declined" }), "Declined");
  assert.equal(stepStatusText({ status: "running" }), "Running");
});

test("quoteDetails labels arguments as the composer does and leaves out the prompt and call plumbing", () => {
  assert.deepEqual(quoteDetails({
    prompt: "A fox", model: "seedance-2.5", aspectRatio: "16:9", durationSeconds: 5, resolution: "1080p", count: 2,
    generateAudio: false, someKey: "x", wait: false, quoteToken: "t", referenceImageIds: ["a"], seed: null,
  }), [
    { key: "model", label: "Model", value: "seedance-2.5" },
    { key: "aspectRatio", label: "Aspect ratio", value: "16:9" },
    { key: "durationSeconds", label: "Duration", value: "5s" },
    { key: "resolution", label: "Resolution", value: "1080p" },
    { key: "count", label: "Count", value: "2" },
    { key: "generateAudio", label: "Audio", value: "No" },
    { key: "someKey", label: "Some key", value: "x" },
  ]);
  assert.deepEqual(quoteDetails({ duration: 10 }), [{ key: "duration", label: "Duration", value: "10s" }]);
  assert.deepEqual(quoteDetails(undefined), []);
  assert.equal(sentenceCase("generate_video"), "Generate video");
  assert.equal(sentenceCase("AspectRatio"), "Aspect ratio");
});

const said = (id, role, content, fields = {}) => ({ id, role, content, toolTrace: null, createdAt: 0, ...fields });
// What threadEntries returns, in words: a saved message's text, or a run segment's run id and items.
const shape = (entries) => entries.map((entry) => (entry.panel
  ? [entry.run.view.runId, entry.items.map((item) => item.text ?? item.content ?? `${item.tool}:${item.status}`), entry.last]
  : entry.message.content));

test("threadEntries shows each run's activity after its start message and before its saved reply", () => {
  const completed = runView(applyPage(runState(run()), page(FULL, { run: run({ status: "completed", updatedAt: 99 }) })));
  const failed = runView(applyPage(runState(run({ id: "run-0" })), page([
    event(1, "run_queued", { messageId: "m-0" }),
    event(2, "step_started", { stepIndex: 0, kind: "tool", tool: "generate_image" }),
    event(3, "tool_called", { stepIndex: 0, tool: "generate_image", outcome: "error", ok: false, summary: "The provider refused it." }),
    event(4, "failed", { code: "model_error", message: "The model stopped answering." }),
  ], { run: run({ id: "run-0", status: "failed", updatedAt: 50 }) })));
  const messages = [
    said("m-0", "user", "Make a fox."),
    said("m-1", "user", "Make a fox video."),
    said("a-1", "assistant", "Your fox video is ready.", { toolTrace: { runId: "run-1", stepIndex: 3 } }),
    said("m-2", "user", "Thanks."),
  ];
  const entries = threadEntries(messages, [{ view: failed, live: false }, { view: completed, live: false }]);
  assert.deepEqual(shape(entries), [
    "Make a fox.",
    ["run-0", ["generate_image:error"], true],
    "Make a fox video.",
    ["run-1", ["Let me look.", "search_generations:done", "generate_video:done"], false],
    "Your fox video is ready.",
    ["run-1", [], true],
    "Thanks.",
  ]);
  assert.equal(entries[1].run.view.outcome.status, "failed", "the failed run's last segment carries how it ended");
  assert.equal(new Set(entries.filter((entry) => entry.panel).map((entry) => entry.key)).size, 3, "segment keys are unique");
});

test("threadEntries places a message the run read where it read it, once, and keeps a live run's unsaved reply", () => {
  const events = [
    event(1, "run_queued", { messageId: "m-1" }),
    event(2, "step_started", { stepIndex: 0, kind: "tool", tool: "search_generations" }),
    event(3, "tool_called", { stepIndex: 0, tool: "search_generations", outcome: "ok", ok: true }),
    event(4, "message_queued", { inboxId: "i-1" }),
    event(5, "message_delivered", { inboxId: "i-1", stepIndex: 1 }),
    event(6, "assistant_text", { stepIndex: 1, text: "Making it blue.", final: true }),
  ];
  const inbox = { id: "i-1", runId: "run-1", content: "Make it blue", attachments: [], createdAt: 50 };
  const live = runView(applyPage(runState(run()), page(events, { pendingMessages: [inbox] })));
  const start = [said("m-1", "user", "Find my foxes.")];
  // Live, before the thread is re-read: the feed shows what the run read and its reply.
  assert.deepEqual(shape(threadEntries(start, [{ view: live, live: true }])), [
    "Find my foxes.", ["run-1", ["search_generations:done", "Make it blue", "Making it blue."], true],
  ]);
  // Re-read (or after a reload, when this tab never saw the message queued): the saved copies take their places.
  const saved = [...start, said("u-1", "user", "Make it blue", { runId: "run-1", deliveredStep: 1 }),
    said("a-1", "assistant", "Making it blue.", { toolTrace: { runId: "run-1", stepIndex: 1 } })];
  const reloaded = runView(applyPage(runState(run({ status: "completed" })), page([...events, event(7, "completed", { steps: 2 })],
    { run: run({ status: "completed", updatedAt: 99 }) })));
  for (const view of [live, reloaded]) {
    assert.deepEqual(shape(threadEntries(saved, [{ view, live: view === live }])), [
      "Find my foxes.", ["run-1", ["search_generations:done"], false], "Make it blue", "Making it blue.", ["run-1", [], true],
    ]);
  }
  // A delivered message whose text this tab never saw and the thread does not hold yet is left out, not shown blank.
  assert.deepEqual(shape(threadEntries(start, [{ view: reloaded, live: false }])), [
    "Find my foxes.", ["run-1", ["search_generations:done", "Making it blue."], true],
  ]);
});

test("a message queued into a run that is stopped shows as a saved message once the run settles, not as queued", () => {
  const inbox = { id: "i-1", runId: "run-1", content: "Make it blue", attachments: [{ id: "u-1", kind: "document", name: "brief.pdf" }],
    createdAt: 50 };
  let state = applyPage(runState(run()), page([
    event(1, "run_queued", { messageId: "m-1" }),
    event(2, "step_started", { stepIndex: 0, kind: "tool", tool: "search_generations" }),
    event(3, "tool_called", { stepIndex: 0, tool: "search_generations", outcome: "ok", ok: true }),
    event(4, "cancel_requested", { cancelJobs: false }),
  ], { run: run({ cancelRequestedAt: 5 }) }));
  state = addQueuedMessage(state, inbox, run({ cancelRequestedAt: 5, updatedAt: 11 }));
  assert.deepEqual(runView(state).queued.map((row) => row.content), ["Make it blue"]);
  state = applyPage(state, page([
    event(5, "message_queued", { inboxId: "i-1" }),
    event(6, "message_delivered", { inboxId: "i-1", stepIndex: 1 }),
    event(7, "cancelled", { cancelJobs: false, jobs: [] }),
  ], { run: run({ status: "cancelled", cancelRequestedAt: 5, stepCount: 1, updatedAt: 99 }) }));
  const view = runView(state);
  assert.deepEqual(view.queued, []);
  assert.equal(view.outcome.status, "cancelled");
  const saved = [said("m-1", "user", "Find my foxes."),
    said("u-1", "user", "Make it blue", { runId: "run-1", deliveredStep: 1, attachments: inbox.attachments })];
  const entries = threadEntries(saved, [{ view, live: true }]);
  assert.deepEqual(shape(entries), ["Find my foxes.", ["run-1", ["search_generations:done"], false], "Make it blue", ["run-1", [], true]]);
  assert.deepEqual(entries[2].message.attachments, inbox.attachments);
});

test("threadEntries puts a live run without a loaded start message at the end and drops an ended one", () => {
  const view = runView(applyPage(runState(run()), page(FULL.slice(0, 6))));
  const messages = [said("m-9", "user", "Older.")];
  assert.deepEqual(shape(threadEntries(messages, [{ view: { ...view, startMessageId: "gone" }, live: true }])), [
    "Older.", ["run-1", ["Let me look.", "search_generations:done"], true],
  ]);
  assert.deepEqual(shape(threadEntries(messages, [{ view: { ...view, startMessageId: "gone" }, live: false }])), ["Older."]);
});
