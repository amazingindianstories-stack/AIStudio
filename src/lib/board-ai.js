import { create } from "zustand";
import { apiFetch } from "./api";
import { apiErrorMessage } from "./api-error";
import { AI_FORMATS, placedCenter } from "./canvas/ai-formats";
import { useCanvasStore } from "./canvas-store";

// Board "Create with AI" jobs (backend/apps/canvas/ai_jobs.py). The server queues each job on the generation
// worker; this module quotes, submits (one Idempotency-Key per request, reused on retry, so a double click or a
// retried request never queues a second paid job), polls until the job ends, then places the result on the board
// and marks it placed so a reload or another tab never places it twice.

export const ACTIVE_STATUSES = ["queued", "running"];
const POLL_MS = 1500;
const HIDDEN_POLL_MS = 6000;

function jobsPath(boardId, suffix = "") {
  return `/api/canvas-boards/${encodeURIComponent(boardId)}/ai-jobs${suffix}`;
}

async function readJson(response) {
  return response.json().catch(() => ({}));
}

async function send(path, method, body, headers = {}) {
  const response = await apiFetch(path, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const json = await readJson(response);
  if (!response.ok) {
    const error = new Error(apiErrorMessage(json, response.status));
    error.status = response.status;
    error.code = json?.code;
    throw error;
  }
  return json;
}

export async function quoteBoardAi(boardId, request, { signal } = {}) {
  const response = await apiFetch(jobsPath(boardId, "/quote"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
    signal,
  });
  const json = await readJson(response);
  if (!response.ok) throw new Error(apiErrorMessage(json, response.status, "Cost estimate unavailable."));
  return json.quote;
}

export async function submitBoardAi(boardId, request, idempotencyKey) {
  return (await send(jobsPath(boardId), "POST", request, { "Idempotency-Key": idempotencyKey })).job;
}

export async function fetchBoardAiJobs(boardId, ids = []) {
  const query = ids.length ? `?ids=${encodeURIComponent(ids.join(","))}` : "";
  const response = await apiFetch(jobsPath(boardId) + query);
  const json = await readJson(response);
  if (!response.ok) throw new Error(apiErrorMessage(json, response.status));
  return json.jobs ?? [];
}

export async function markBoardAiPlaced(boardId, jobId, nodeIds) {
  return (await send(jobsPath(boardId, `/${encodeURIComponent(jobId)}`), "PATCH", { placedNodeIds: nodeIds })).job;
}

/** The request fields a job is submitted with; equal requests reuse one idempotency key. */
export function requestFingerprint(boardId, request) {
  return JSON.stringify([boardId, request.format, request.prompt, request.parentJobId ?? null, request.model ?? null, request.aspectRatio ?? null]);
}

let pollTimer = null;
let generation = 0;

function clearPoll() {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
}

/**
 * `job` is the job the panel follows; `placed` is the last result this tab placed (the one Refine builds on);
 * `pendingKey` keeps the key of a submission whose answer never arrived, so retrying the same request reuses it.
 */
export const useBoardAi = create((set, get) => ({
  boardId: null,
  job: null,
  placed: null,
  submitting: false,
  error: null,
  pendingKey: null,

  /** Follow `boardId`: forget the previous board's job and resume this one's unfinished or unplaced jobs. */
  attach: async (boardId) => {
    if (get().boardId === boardId) return;
    clearPoll();
    generation += 1;
    const mine = generation;
    set({ boardId, job: null, placed: null, submitting: false, error: null, pendingKey: null });
    if (!boardId) return;
    let jobs = [];
    try {
      jobs = await fetchBoardAiJobs(boardId);
    } catch {
      return;
    }
    if (mine !== generation) return;
    // Oldest first, so the newest active or finished job ends up as the one the panel follows.
    for (const job of [...jobs].reverse()) {
      await get().settle(job, mine);
      if (mine !== generation) return;
    }
  },

  detach: () => {
    clearPoll();
    generation += 1;
    set({ boardId: null, job: null, placed: null, submitting: false, error: null, pendingKey: null });
  },

  /** Start a fresh prompt: the next job is not a refinement of the last result. */
  startOver: () => set({ placed: null, error: null, job: get().job && ACTIVE_STATUSES.includes(get().job.status) ? get().job : null }),

  submit: async (request) => {
    const { boardId, submitting, pendingKey } = get();
    if (!boardId || submitting) return null;
    const fingerprint = requestFingerprint(boardId, request);
    const key = pendingKey?.fingerprint === fingerprint ? pendingKey.key : crypto.randomUUID();
    set({ submitting: true, error: null, pendingKey: { fingerprint, key } });
    const mine = generation;
    try {
      const job = await submitBoardAi(boardId, request, key);
      if (mine !== generation) return job;
      set({ submitting: false, pendingKey: null, job });
      await get().settle(job, mine);
      return job;
    } catch (error) {
      if (mine !== generation) return null;
      // A refusal is final for this request: the next submission gets a new key. A dropped answer keeps the key.
      const answered = typeof error?.status === "number";
      set({ submitting: false, error: error?.message || "Could not start the job.", pendingKey: answered ? null : get().pendingKey });
      return null;
    }
  },

  /** Act on a job's latest state: keep polling it, place its result, or show why it failed. */
  settle: async (job, mine = generation) => {
    if (mine !== generation) return;
    if (ACTIVE_STATUSES.includes(job.status)) {
      set({ job });
      schedulePoll(get, set, job.id, mine);
      return;
    }
    if (job.status === "succeeded" && !job.placedAt) {
      await placeJob(get, set, job, mine);
      return;
    }
    if (!job.placedAt) {
      // A failed or cancelled job has nothing to place: record that it was seen so a reload does not show it again.
      markBoardAiPlaced(job.boardId, job.id, []).catch(() => {});
    }
    set({ job, error: job.status === "succeeded" ? null : job.error || "The job did not finish." });
  },
}));

function schedulePoll(get, set, jobId, mine) {
  clearPoll();
  const hidden = typeof document !== "undefined" && document.visibilityState === "hidden";
  pollTimer = setTimeout(async () => {
    pollTimer = null;
    if (mine !== generation) return;
    const { boardId } = get();
    try {
      const [job] = await fetchBoardAiJobs(boardId, [jobId]);
      if (mine !== generation) return;
      if (job) await get().settle(job, mine);
    } catch {
      if (mine === generation) schedulePoll(get, set, jobId, mine);
    }
  }, hidden ? HIDDEN_POLL_MS : POLL_MS);
}

async function placeJob(get, set, job, mine) {
  const format = AI_FORMATS[job.format];
  const canvas = useCanvasStore.getState();
  // Place only on the board the job belongs to, once it has loaded; otherwise leave it for that board's next visit.
  if (!format || canvas.boardId !== job.boardId || !canvas.loaded) {
    set({ job });
    return;
  }
  const previous = get().placed;
  const refines = previous && job.parentJobId === previous.jobId;
  const replaceIds = refines ? previous.nodeIds : [];
  const center = (refines && placedCenter(canvas.history.present.nodes, replaceIds)) || canvas.viewportCenter();
  const nodes = format.nodes(job, center);
  let marked;
  try {
    // Claim the placement first: only the caller whose mark succeeds inserts the nodes.
    marked = await markBoardAiPlaced(job.boardId, job.id, nodes.map((node) => node.id));
  } catch (error) {
    if (mine !== generation) return;
    if (error?.code === "ALREADY_PLACED") {
      set({ job: { ...job, placedAt: Date.now() } });
      return;
    }
    set({ job, error: error?.message || "Could not place the result." });
    return;
  }
  if (mine !== generation || useCanvasStore.getState().boardId !== job.boardId) return;
  useCanvasStore.getState().placeGeneratedNodes(nodes, replaceIds);
  set({ job: marked, error: null, placed: { jobId: job.id, format: job.format, prompt: job.prompt, nodeIds: nodes.map((node) => node.id), result: job.result } });
}
