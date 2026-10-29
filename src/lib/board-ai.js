import { create } from "zustand";
import { apiFetch } from "./api";
import { apiErrorMessage } from "./api-error";
import { AI_FORMATS, inFreeSpace, placedCenter, screenRectToBoard, viewportShowing } from "./canvas/ai-formats";
import { useCanvasStore } from "./canvas-store";

// Board "Create with AI" jobs (backend/apps/canvas/ai_jobs.py). The server queues each job on the generation
// worker; this module quotes, submits (one Idempotency-Key per request, reused on retry, so a double click or a
// retried request never queues a second paid job), polls each unfinished job until it ends, then places its result on
// the board and marks it placed so a reload or another tab never places it twice. The owner's finished results of the last
// day stay listed, so any of them can be placed again without a new job. A placed result is always left in view:
// the canvas the open panels cover counts as occupied space, and the board pans when the result would still be hidden.

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

export async function fetchBoardAiJobs(boardId, ids = [], { recent = false } = {}) {
  const query = ids.length ? `?ids=${encodeURIComponent(ids.join(","))}` : recent ? "?recent=1" : "";
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
  return JSON.stringify([boardId, request.format, request.prompt, request.processing ?? null, request.parentJobId ?? null, request.model ?? null,
    request.aspectRatio ?? null]);
}

const pollTimers = new Map();
let placing = Promise.resolve();
let generation = 0;
let newestFollowed = -Infinity;
let newPrompts = 0;
let measureLayout = null;

/**
 * The open panel reports, in canvas pixels, its own rect (`panel`) and the canvas area side panels leave visible
 * (`visible`) through `measure`; the returned function stops reporting.
 */
export function trackPanelLayout(measure) {
  measureLayout = measure;
  return () => {
    if (measureLayout === measure) measureLayout = null;
  };
}

/** The panel's layout, or the whole canvas with no panel while it is closed. */
function layout(canvas) {
  const measured = measureLayout?.();
  if (measured) return measured;
  const size = canvas.viewportSize();
  return { panel: null, visible: { x: 0, y: 0, w: size.w, h: size.h } };
}

/** Board space a new result must avoid: the board's nodes (less `exclude`) and the board area the panels cover. */
function occupied(canvas, exclude = []) {
  const nodes = canvas.history.present.nodes.filter((node) => !exclude.includes(node.id));
  const { panel, visible } = layout(canvas);
  const { viewport } = canvas.history.present;
  const covered = [panel, visible.x > 0 ? { x: 0, y: visible.y, w: visible.x, h: visible.h } : null].filter(Boolean);
  return [...nodes, ...covered.map((rect) => screenRectToBoard(rect, viewport))];
}

/** Insert `nodes` as one undo step, then pan (instantly) if they are not fully visible outside the panels. */
function insertVisible(nodes, replaceIds) {
  const canvas = useCanvasStore.getState();
  canvas.placeGeneratedNodes(nodes, replaceIds);
  const { viewport } = useCanvasStore.getState().history.present;
  const { panel, visible } = layout(canvas);
  const shown = viewportShowing(nodes, viewport, visible, panel);
  if (shown !== viewport) canvas.setViewport(shown);
}

function clearPolls() {
  for (const timer of pollTimers.values()) clearTimeout(timer);
  pollTimers.clear();
}

/**
 * `state` unless `job` settles in the background: the user did not choose to place it, and the panel follows a newer
 * job, or follows none since Start over and has followed this job or a newer one since attaching.
 */
function panelState(get, job, chosen, state) {
  const current = get().job;
  const background = current ? current.id !== job.id && job.createdAt < newestFollowed : job.createdAt <= newestFollowed;
  if (!chosen && background) return {};
  if (job.createdAt > newestFollowed) newestFollowed = job.createdAt;
  return state;
}

/** Settle `job` in the background from now on: New prompt was pressed after it was submitted or listed. */
function toBackground(job) {
  if (job.createdAt > newestFollowed) newestFollowed = job.createdAt;
}

/** Run placements one at a time, so each finds free space after the previous one is on the board. */
function oneAtATime(place) {
  const run = placing.then(place);
  placing = run.catch(() => {});
  return run;
}

/** True while `job`'s board is the loaded board in the canvas store. */
function onItsBoard(job) {
  const canvas = useCanvasStore.getState();
  return canvas.boardId === job.boardId && canvas.loaded;
}

function placedResult(job, nodes) {
  return { jobId: job.id, format: job.format, prompt: job.prompt, nodeIds: nodes.map((node) => node.id), result: job.result };
}

/**
 * `job` is the job the panel follows; `placed` is the last result this tab placed (the one Refine builds on);
 * `recent` is the owner's finished results on this board from the last day; `pendingKey` keeps the key of a
 * submission whose answer never arrived, so retrying the same request reuses it.
 */
export const useBoardAi = create((set, get) => ({
  boardId: null,
  job: null,
  placed: null,
  recent: [],
  submitting: false,
  error: null,
  pendingKey: null,

  /** Follow `boardId`: forget the previous board's job and resume this one's unfinished or unplaced jobs. */
  attach: async (boardId) => {
    if (get().boardId === boardId) return;
    clearPolls();
    generation += 1;
    newestFollowed = -Infinity;
    const mine = generation;
    set({ boardId, job: null, placed: null, recent: [], submitting: false, error: null, pendingKey: null });
    if (!boardId) return;
    let jobs = [];
    try {
      jobs = await fetchBoardAiJobs(boardId);
    } catch {
      return;
    }
    if (mine !== generation) return;
    const prompts = newPrompts;
    // Oldest first, so the newest active or finished job ends up as the one the panel follows.
    for (const job of [...jobs].reverse()) {
      if (prompts !== newPrompts) toBackground(job);
      await get().settle(job, mine);
      if (mine !== generation) return;
    }
  },

  detach: () => {
    clearPolls();
    generation += 1;
    newestFollowed = -Infinity;
    set({ boardId: null, job: null, placed: null, recent: [], submitting: false, error: null, pendingKey: null });
  },

  /** Refresh the owner's finished results on this board from the last day (placed or not). */
  loadRecent: async () => {
    const { boardId } = get();
    if (!boardId) return;
    const mine = generation;
    try {
      const recent = await fetchBoardAiJobs(boardId, [], { recent: true });
      if (mine === generation) set({ recent });
    } catch {
      // The list is a convenience; the next refresh tries again.
    }
  },

  /**
   * Put a finished result on the board again, in free space near the viewport centre, as one undo step. It never
   * submits or bills a job; a result that was never placed is claimed first, like any first placement.
   */
  placeAgain: async (job) => {
    const format = AI_FORMATS[job.format];
    if (!format || job.status !== "succeeded" || !onItsBoard(job)) return;
    if (!job.placedAt) {
      await placeJob(get, set, job, generation, true);
      return;
    }
    const mine = generation;
    await oneAtATime(() => {
      if (mine !== generation || !onItsBoard(job)) return;
      const canvas = useCanvasStore.getState();
      const nodes = inFreeSpace(format.nodes(job, canvas.viewportCenter()), occupied(canvas));
      if (!nodes.length) return;
      insertVisible(nodes, []);
      set({ error: null, placed: placedResult(job, nodes) });
    });
  },

  /**
   * Start a fresh prompt: the next job is not a refinement of the last result. A job still running carries on in the
   * background: its result is placed when it ends, but it never becomes the panel's job or refine target again.
   */
  startOver: () => {
    newPrompts += 1;
    set({ job: null, placed: null, error: null });
  },

  submit: async (request) => {
    const { boardId, submitting, pendingKey } = get();
    if (!boardId || submitting) return null;
    const fingerprint = requestFingerprint(boardId, request);
    const key = pendingKey?.fingerprint === fingerprint ? pendingKey.key : crypto.randomUUID();
    set({ submitting: true, error: null, pendingKey: { fingerprint, key } });
    const mine = generation;
    const prompts = newPrompts;
    try {
      const job = await submitBoardAi(boardId, request, key);
      if (mine !== generation) return job;
      if (prompts === newPrompts) {
        set({ submitting: false, pendingKey: null, job });
      } else {
        toBackground(job);
        set({ submitting: false, pendingKey: null });
      }
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
      set(panelState(get, job, false, { job }));
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
    set(panelState(get, job, false, { job, error: job.status === "succeeded" ? null : job.error || "The job did not finish." }));
  },
}));

function schedulePoll(get, set, jobId, mine) {
  clearTimeout(pollTimers.get(jobId));
  const hidden = typeof document !== "undefined" && document.visibilityState === "hidden";
  pollTimers.set(jobId, setTimeout(async () => {
    pollTimers.delete(jobId);
    if (mine !== generation) return;
    const { boardId } = get();
    try {
      const [job] = await fetchBoardAiJobs(boardId, [jobId]);
      if (mine !== generation) return;
      if (job) await get().settle(job, mine);
    } catch {
      if (mine === generation) schedulePoll(get, set, jobId, mine);
    }
  }, hidden ? HIDDEN_POLL_MS : POLL_MS));
}

function placeJob(get, set, job, mine, chosen = false) {
  return oneAtATime(() => claimAndInsert(get, set, job, mine, chosen));
}

async function claimAndInsert(get, set, job, mine, chosen) {
  if (mine !== generation) return;
  const format = AI_FORMATS[job.format];
  // Place only on the board the job belongs to, once it has loaded; otherwise leave it for that board's next visit.
  if (!format || !onItsBoard(job)) {
    set(panelState(get, job, chosen, { job }));
    return;
  }
  const canvas = useCanvasStore.getState();
  const previous = get().placed;
  const refines = previous && job.parentJobId === previous.jobId;
  const replaceIds = refines ? previous.nodeIds : [];
  const previousCenter = refines ? placedCenter(canvas.history.present.nodes, replaceIds) : null;
  // A refinement takes the place of the result it refines; a new result goes to free space near the viewport centre.
  const nodes = previousCenter
    ? format.nodes(job, previousCenter)
    : inFreeSpace(format.nodes(job, canvas.viewportCenter()), occupied(canvas, replaceIds));
  let marked;
  try {
    // Claim the placement first: only the caller whose mark succeeds inserts the nodes.
    marked = await markBoardAiPlaced(job.boardId, job.id, nodes.map((node) => node.id));
  } catch (error) {
    if (mine !== generation) return;
    if (error?.code === "ALREADY_PLACED") {
      set(panelState(get, job, chosen, { job: { ...job, placedAt: Date.now() } }));
      return;
    }
    set(panelState(get, job, chosen, { job, error: error?.message || "Could not place the result." }));
    return;
  }
  if (mine !== generation || !onItsBoard(job)) return;
  insertVisible(nodes, replaceIds);
  set(panelState(get, job, chosen, { job: marked, error: null, placed: placedResult(job, nodes) }));
}
