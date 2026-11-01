import { create } from "zustand";
import { apiFetch } from "../api";
import { clockOffset } from "./facilitation";

const EMPTY = {
  timer: null,
  voting: { active: null, shown: null, savedCount: 0 },
  privateMode: { active: false },
};

let voteQueue = Promise.resolve();

async function request(boardId, path, method = "GET", body) {
  const res = await apiFetch(`/api/canvas-boards/${boardId}${path}`, {
    method,
    cache: "no-store",
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Request failed: ${res.status}`);
  return json;
}

/**
 * Live facilitation state of the open board: the timer, the voting session and the private mode setting.
 * It is a separate store from the board graph; the poll hook keeps it fresh, every action re-reads it.
 */
export const useFacilitationStore = create((set, get) => ({
  boardId: null,
  ...EMPTY,
  offset: 0,
  loaded: false,
  muted: false,
  /** Last run whose chime rang, so a reload never rings an old countdown again. */
  rungRun: null,

  open(boardId) {
    if (get().boardId !== boardId) set({ boardId, ...EMPTY, offset: 0, loaded: false, rungRun: null });
  },
  close() {
    set({ boardId: null, ...EMPTY, loaded: false });
  },
  setMuted(muted) {
    set({ muted });
  },
  markRung(run) {
    set({ rungRun: run });
  },

  /** One snapshot read; resolves true when the snapshot changed anything a person would see. */
  async refresh() {
    const boardId = get().boardId;
    if (!boardId) return false;
    const sentAt = Date.now();
    try {
      const snap = await request(boardId, "/facilitation");
      if (get().boardId !== boardId) return false;
      if (!snap || !snap.voting || !snap.privateMode) return false;
      const offset = clockOffset(snap.serverNow, sentAt, Date.now());
      const first = !get().loaded;
      const { timer, voting, privateMode } = snap;
      // A timer already past its end when the board opens has rung for someone else; do not ring it again.
      const stale = first && timer?.state === "running" && timer.endsAt != null && timer.endsAt <= Date.now() + offset;
      set({ timer, voting, privateMode, offset, loaded: true, ...(stale ? { rungRun: timer.run } : {}) });
      return true;
    } catch {
      return false;
    }
  },

  async timerAction(data) {
    const boardId = get().boardId;
    await request(boardId, "/timer", "POST", data);
    await get().refresh();
  },
  async createSession(data) {
    const boardId = get().boardId;
    const json = await request(boardId, "/voting", "POST", data);
    await get().refresh();
    return json.session;
  },
  async sessionAction(sessionId, data) {
    const boardId = get().boardId;
    await request(boardId, `/voting/${sessionId}`, "POST", data);
    await get().refresh();
  },
  async castVote(sessionId, nodeId, votes) {
    const boardId = get().boardId;
    const { active } = get().voting;
    const json = await request(boardId, `/voting/${sessionId}/vote`, "POST", { nodeId, votes });
    // The reply is this person's whole ballot; show it at once, the next poll confirms.
    if (active && active.id === sessionId) {
      const myVotes = json.myVotes ?? {};
      const votesUsed = Object.values(myVotes).reduce((sum, count) => sum + count, 0);
      set({ voting: { ...get().voting, active: { ...active, myVotes, votesUsed } } });
    }
  },
  /** Adds or removes one vote. Clicks queue, so a second click builds on the first one's reply, not on a stale count. */
  adjustVote(sessionId, nodeId, delta) {
    const run = voteQueue.then(() => {
      const { active } = get().voting;
      if (!active || active.id !== sessionId) return null;
      const next = Math.max(0, (active.myVotes?.[nodeId] ?? 0) + delta);
      return get().castVote(sessionId, nodeId, next);
    });
    voteQueue = run.catch(() => {});
    return run;
  },
  async markDone(sessionId, done = true) {
    const boardId = get().boardId;
    await request(boardId, `/voting/${sessionId}/done`, "POST", { done });
    await get().refresh();
  },
  async listSessions() {
    const json = await request(get().boardId, "/voting");
    return json.sessions ?? [];
  },
  async privateAction(data) {
    const boardId = get().boardId;
    await request(boardId, "/private-mode", "POST", data);
    await get().refresh();
  },
}));
