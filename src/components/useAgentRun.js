"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  addQueuedMessage, applyPage, drainFeed, forgetRunState, isActiveStatus, isSettled, pollDelay, restoreRunState, runAction,
  runState, saveRunState, withRun,
} from "@/lib/agent-run";
import { apiErrorMessage } from "@/lib/api-error";

const STALE = Symbol("stale");

/** One page of the run's event feed; rejects with the API's message (and `status`) when it is refused. */
async function fetchEvents(conversationId, runId, after) {
  const response = await fetch(`/api/agent-conversations/${conversationId}/runs/${runId}/events?after=${after}`, { cache: "no-store" });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(apiErrorMessage(data, response.status)), { status: response.status });
  return data;
}
/** Consecutive failed polls before the panel says it lost touch with the run (it keeps retrying with backoff). */
const QUIET_FAILURES = 3;

/**
 * The conversation's current agent run, kept in step with its event feed. On open it reads `GET .../runs` and resumes
 * polling an active run from the seq this tab saved; a send hands it the run it started (`adopt`) or the message it
 * queued (`queue`). Once the run ends and its feed is drained, `onSettled(state)` refreshes the persisted thread and
 * `synced` turns true, so the thread shows the saved messages and the panel keeps only the run's activity.
 */
export function useAgentRun(conversationId, { onSettled } = {}) {
  const [state, setState] = useState(null);
  const [earlier, setEarlier] = useState([]);
  const [syncedRunId, setSyncedRunId] = useState(null);
  const [pollError, setPollError] = useState(null);
  const stateRef = useRef(null);
  const tokenRef = useRef(0);
  const timerRef = useRef(null);
  const pollingRef = useRef(false);
  const againRef = useRef(false);
  const failuresRef = useRef(0);
  const conversationRef = useRef(conversationId);
  conversationRef.current = conversationId;
  const onSettledRef = useRef(onSettled);
  onSettledRef.current = onSettled;
  const pollRef = useRef(null);

  const commit = useCallback((update) => {
    const next = typeof update === "function" ? update(stateRef.current) : update;
    stateRef.current = next;
    setState(next);
    return next;
  }, []);

  const schedule = useCallback((ms) => {
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => pollRef.current?.(), ms);
  }, []);

  const settle = useCallback(async (settled, token) => {
    forgetRunState(settled.run.id);
    try {
      await onSettledRef.current?.(settled);
    } finally {
      if (token === tokenRef.current) setSyncedRunId(settled.run.id);
    }
  }, []);

  const poll = useCallback(async () => {
    clearTimeout(timerRef.current);
    timerRef.current = null;
    if (pollingRef.current) {
      againRef.current = true;
      return;
    }
    const start = stateRef.current;
    if (!start?.run?.id || isSettled(start)) return;
    const token = tokenRef.current;
    const conversation = conversationRef.current;
    const runId = start.run.id;
    pollingRef.current = true;
    let refused = null;
    try {
      await drainFeed(start, async (after) => {
        const data = await fetchEvents(conversation, runId, after);
        if (token !== tokenRef.current) throw STALE;
        commit((current) => (current?.run?.id === runId ? applyPage(current, data) : current));
        return data;
      });
      failuresRef.current = 0;
      setPollError(null);
    } catch (error) {
      if (error === STALE || token !== tokenRef.current) return;
      failuresRef.current += 1;
      // The run is gone or the Agents tab was switched off: polling again cannot help.
      if (error?.status === 403 || error?.status === 404) refused = error.message;
      else if (failuresRef.current >= QUIET_FAILURES) setPollError("Lost touch with the run. Trying again…");
    } finally {
      if (token === tokenRef.current) pollingRef.current = false;
    }
    if (token !== tokenRef.current) return;
    const current = stateRef.current;
    if (!current) return;
    if (current.run.id !== runId) {
      schedule(0);
      return;
    }
    saveRunState(current);
    if (refused) {
      setPollError(refused);
      return;
    }
    if (isSettled(current)) {
      await settle(current, token);
      return;
    }
    const again = againRef.current;
    againRef.current = false;
    schedule(again ? 0 : pollDelay(current, failuresRef.current));
  }, [commit, schedule, settle]);
  pollRef.current = poll;

  useEffect(() => {
    tokenRef.current += 1;
    const token = tokenRef.current;
    clearTimeout(timerRef.current);
    pollingRef.current = false;
    againRef.current = false;
    failuresRef.current = 0;
    commit(null);
    setEarlier([]);
    setSyncedRunId(null);
    setPollError(null);
    if (!conversationId) return undefined;
    (async () => {
      const response = await fetch(`/api/agent-conversations/${conversationId}/runs`, { cache: "no-store" }).catch(() => null);
      const data = response ? await response.json().catch(() => ({})) : {};
      // A send that answered first already adopted the run.
      if (token !== tokenRef.current || !response?.ok || stateRef.current) return;
      const latest = data.runs?.[0];
      if (!latest) return;
      if (isActiveStatus(latest.status)) {
        commit(restoreRunState(latest));
        pollRef.current?.();
        return;
      }
      forgetRunState(latest.id);
      // The thread already holds what a finished run wrote; a failed or stopped one still shows its steps and how it
      // ended, read from its feed (the run JSON alone does not say which jobs a stop cancelled).
      if (latest.status !== "completed") {
        const ended = await drainFeed(runState(latest), (after) => fetchEvents(conversationId, latest.id, after)).catch(() => runState(latest));
        if (token !== tokenRef.current || stateRef.current) return;
        commit({ ...ended, more: false });
        setSyncedRunId(latest.id);
      }
    })();
    return () => {
      tokenRef.current += 1;
      clearTimeout(timerRef.current);
    };
  }, [conversationId, commit]);

  /** Follows `run` from now on; the run this replaces stays in `earlier` when its activity was read. */
  const adopt = useCallback((run, { fresh = false } = {}) => {
    const previous = stateRef.current;
    if (previous?.run?.id === run.id) {
      commit(withRun(previous, run));
    } else {
      if (previous && isSettled(previous) && Object.keys(previous.events).length) setEarlier((list) => [...list, previous]);
      commit(fresh ? runState(run) : restoreRunState(run));
      failuresRef.current = 0;
      setPollError(null);
    }
    poll();
  }, [commit, poll]);

  /** Shows a message the run's inbox accepted (a 202) until the run reads it. */
  const queue = useCallback((inbox, run) => {
    if (stateRef.current?.run?.id !== run.id) adopt(run);
    commit((current) => addQueuedMessage(current, inbox, run));
    poll();
  }, [adopt, commit, poll]);

  /** Approve, decline or cancel; resolves to `runAction`'s result and polls straight away either way. */
  const act = useCallback(async (action, body) => {
    const current = stateRef.current;
    if (!current?.run?.id || !conversationRef.current) return { ok: false, error: "There is no run to change." };
    const token = tokenRef.current;
    const result = await runAction(conversationRef.current, current.run.id, action, body);
    if (token !== tokenRef.current) return result;
    if (result.ok) commit((latest) => (latest?.run?.id === result.run.id ? withRun(latest, result.run) : latest));
    poll();
    return result;
  }, [commit, poll]);

  return { state, earlier, synced: Boolean(state?.run?.id) && syncedRunId === state.run.id, pollError, adopt, queue, act };
}
