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
/** Feeds of runs that ended, read once per tab: a finished run's events never change. */
const ENDED = new Map();
const MAX_ENDED = 200;

function remember(state) {
  ENDED.delete(state.run.id);
  ENDED.set(state.run.id, state);
  if (ENDED.size > MAX_ENDED) ENDED.delete(ENDED.keys().next().value);
  return state;
}

/** The drained feed of a run that ended; a feed that cannot be read leaves the run JSON alone (and is read again later). */
async function readEnded(conversationId, run) {
  const known = ENDED.get(run.id);
  if (known && known.run.updatedAt === run.updatedAt) return known;
  try {
    const state = await drainFeed(runState(run), (after) => fetchEvents(conversationId, run.id, after));
    return remember({ ...state, more: false });
  } catch {
    return { ...runState(run), more: false };
  }
}

/** Consecutive failed polls before the panel says it lost touch with the run (it keeps retrying with backoff). */
const QUIET_FAILURES = 3;

/**
 * The conversation's current agent run, kept in step with its event feed. On open it reads `GET .../runs` (the 20 most
 * recent), resumes polling an active run from the seq this tab saved and reads each run that ended into `earlier`
 * (oldest first) once, without polling it; a send hands it the run it started (`adopt`) or the message it queued
 * (`queue`). Once the run ends and its feed is drained, `onSettled(state)` refreshes the persisted thread and `synced`
 * turns true, so the saved messages carry its replies and the messages it read (see threadEntries).
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
    remember(settled);
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
      if (token !== tokenRef.current || !response?.ok) return;
      const runs = data.runs || [];
      const active = runs.find((run) => isActiveStatus(run.status));
      // A send that answered first already adopted the run.
      if (active && !stateRef.current) {
        commit(restoreRunState(active));
        pollRef.current?.();
      }
      // Every run that ended shows its steps, jobs, text and how it ended, read from its feed once (the run JSON alone
      // does not say which jobs a stop cancelled).
      const ended = runs.filter((run) => !isActiveStatus(run.status)).reverse();
      for (const run of ended) forgetRunState(run.id);
      const states = await Promise.all(ended.map((run) => readEnded(conversationId, run)));
      if (token !== tokenRef.current) return;
      setEarlier((list) => {
        const shown = new Set([...list.map((state) => state.run.id), stateRef.current?.run?.id]);
        return [...states.filter((state) => !shown.has(state.run.id)), ...list];
      });
    })();
    return () => {
      tokenRef.current += 1;
      clearTimeout(timerRef.current);
    };
  }, [conversationId, commit]);

  /** Keeps a run that `adopt` replaced in `earlier`: one it had not drained yet is drained once, then settles. */
  const keep = useCallback(async (previous) => {
    const token = tokenRef.current;
    const put = (kept) => {
      if (token !== tokenRef.current || !Object.keys(kept.events).length) return;
      setEarlier((list) => (list.some((item) => item.run.id === kept.run.id)
        ? list.map((item) => (item.run.id === kept.run.id ? kept : item)) : [...list, kept]));
    };
    put(previous);
    if (isSettled(previous)) return;
    const conversation = conversationRef.current;
    const drained = await drainFeed(previous, (after) => fetchEvents(conversation, previous.run.id, after)).catch(() => previous);
    if (token !== tokenRef.current) return;
    put(drained);
    if (!isSettled(drained)) return;
    forgetRunState(drained.run.id);
    remember(drained);
    await onSettledRef.current?.(drained);
  }, []);

  /** Follows `run` from now on when it belongs to the open conversation; the run this replaces stays in `earlier`. */
  const adopt = useCallback((run, { fresh = false } = {}) => {
    if (run.conversationId !== conversationRef.current) return;
    const previous = stateRef.current;
    if (previous?.run?.id === run.id) {
      commit(withRun(previous, run));
    } else {
      if (previous) keep(previous);
      commit(fresh ? runState(run) : restoreRunState(run));
      failuresRef.current = 0;
      setPollError(null);
    }
    poll();
  }, [commit, keep, poll]);

  /** Shows a message the run's inbox accepted (a 202) until the run reads it. */
  const queue = useCallback((inbox, run) => {
    if (run.conversationId !== conversationRef.current) return;
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
