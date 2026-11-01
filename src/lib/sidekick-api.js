import { apiFetch } from "./api";
import { getJson, send } from "./board-ai";

// The Sidekick, Flow, Catch up and AI search endpoints (backend/apps/canvas/views_sidekick.py). Board routes live
// under /assistant/ and need edit access unless noted; the personal ones (catalogue, credits) are per user.

const board = (id, suffix) => `/api/canvas-boards/${encodeURIComponent(id)}/assistant/${suffix}`;
const personal = (suffix) => `/api/canvas-ai/${suffix}`;
const part = (id) => encodeURIComponent(id);

export const fetchCatalogue = () => getJson(personal("sidekicks"));
export const saveSidekick = (sidekick) => (sidekick.id
  ? send(personal(`sidekicks/${part(sidekick.id)}`), "PATCH", sidekick)
  : send(personal("sidekicks"), "POST", sidekick)).then((json) => json.sidekick);
export const deleteSidekick = (id) => send(personal(`sidekicks/${part(id)}`), "DELETE");
export const fetchCredits = () => getJson(personal("credits")).then((json) => json.credits);
export const requestCredits = (message) => send(personal("credits/request"), "POST", { message });
export const fetchFlowTemplates = () => getJson(personal("flow-templates")).then((json) => json.templates);
export const fetchUsage = (request) => send(personal("usage"), "POST", request).then((json) => json.usage);

export const fetchChats = (boardId) => getJson(board(boardId, "sidekick-chats")).then((json) => json.chats);
export const createChat = (boardId, sidekick) => send(board(boardId, "sidekick-chats"), "POST", { sidekick }).then((json) => json.chat);
export const openChat = (boardId, chatId) => getJson(board(boardId, `sidekick-chats/${part(chatId)}`));
export const renameChat = (boardId, chatId, title) => send(board(boardId, `sidekick-chats/${part(chatId)}`), "PATCH", { title });
export const removeChat = (boardId, chatId) => send(board(boardId, `sidekick-chats/${part(chatId)}`), "DELETE");
export const quoteTurn = (boardId, chatId, request) => send(board(boardId, `sidekick-chats/${part(chatId)}/quote`), "POST", request).then((json) => json.quote);
export const submitTurn = (boardId, chatId, request, key) => send(board(boardId, `sidekick-chats/${part(chatId)}/turns`), "POST", request, { "Idempotency-Key": key }).then((json) => json.job);

export const quoteFlow = (boardId, steps) => send(board(boardId, "flows/quote"), "POST", { steps }).then((json) => json.quote);
export const submitStep = (boardId, request, key) => send(board(boardId, "flows/steps"), "POST", request, { "Idempotency-Key": key }).then((json) => json.job);
export const fetchVersions = (boardId, nodeId) => getJson(board(boardId, `flow-versions?nodeId=${part(nodeId)}`)).then((json) => json.versions);
export const recordVersion = (boardId, nodeId, text) => send(board(boardId, "flow-versions"), "POST", { nodeId, text });

/** Mark the board as seen now. Sent when a board is left, so the next visit's Catch up counts from this one; keepalive lets it finish while the page unloads. */
export const recordVisit = (boardId) => apiFetch(board(boardId, "visit"), { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", keepalive: true }).catch(() => {});
export const fetchCatchUp = (boardId, period) => getJson(board(boardId, `catch-up${period ? `?period=${part(period)}` : ""}`)).then((json) => json.catchUp);
export const quoteCatchUp = (boardId, request) => send(board(boardId, "catch-up/quote"), "POST", request).then((json) => json.quote);
export const submitCatchUp = (boardId, request, key) => send(board(boardId, "catch-up/jobs"), "POST", request, { "Idempotency-Key": key }).then((json) => json.job);

export const quoteSearch = (boardId, request) => send(board(boardId, "ai-search/quote"), "POST", request).then((json) => json.quote);
export const submitSearch = (boardId, request, key) => send(board(boardId, "ai-search/jobs"), "POST", request, { "Idempotency-Key": key }).then((json) => json.job);
export const fetchSearch = (boardId, jobId) => getJson(board(boardId, `ai-search/${part(jobId)}`));
export const fetchWork = (boardId, jobId) => getJson(board(boardId, `work/${part(jobId)}`)).then((json) => json.job);

/** Polls a job until it ends. Resolves with the finished job (status succeeded, failed or cancelled). */
export async function waitForJob(boardId, jobId, { signal, fetchJob = fetchWork, interval = (hidden) => (hidden ? 6000 : 1500) } = {}) {
  for (;;) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const job = await fetchJob(boardId, jobId);
    if (!["queued", "running"].includes(job.status)) return job;
    const hidden = typeof document !== "undefined" && document.visibilityState === "hidden";
    await new Promise((resolve) => setTimeout(resolve, interval(hidden)));
  }
}
