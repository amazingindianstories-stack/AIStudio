import { apiFetch } from "../api";

/** Board collaboration requests (backend/apps/canvas/views_collab.py); each rejects with the server's message and `status`. */
async function request(path, { method = "GET", body } = {}) {
  const response = await apiFetch(path, {
    method,
    cache: "no-store",
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(json.error || `Request failed: ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return json;
}

const board = (boardId) => `/api/canvas-boards/${encodeURIComponent(boardId)}`;

export const fetchComments = (boardId) => request(`${board(boardId)}/comments`);
export const pulseBoard = (boardId, since) => request(`${board(boardId)}/pulse${since ? `?since=${since}` : ""}`, { method: "POST", body: {} });
export const createComment = (boardId, body) => request(`${board(boardId)}/comments`, { method: "POST", body });
export const updateComment = (boardId, id, body) => request(`${board(boardId)}/comments/${id}`, { method: "PATCH", body });
export const deleteComment = (boardId, id) => request(`${board(boardId)}/comments/${id}`, { method: "DELETE" });
export const resolveComment = (boardId, id, resolved) => request(`${board(boardId)}/comments/${id}/resolve`, { method: "POST", body: { resolved } });
export const reactToComment = (boardId, id, emoji) => request(`${board(boardId)}/comments/${id}/react`, { method: "POST", body: { emoji } });
export const markCommentsRead = (boardId, body) => request(`${board(boardId)}/comments/read`, { method: "POST", body });
export const followComments = (boardId, body) => request(`${board(boardId)}/comments/follow`, { method: "POST", body });
export const fetchMentionSuggestions = (boardId) => request(`${board(boardId)}/comments/mentions`);

export const fetchNotifications = ({ boardId, before, unread, boards } = {}) => {
  const query = new URLSearchParams();
  if (boardId) query.set("boardId", boardId);
  if (before) query.set("before", before);
  if (unread) query.set("unread", "1");
  if (boards) query.set("boards", "1");
  return request(`/api/notifications${query.size ? `?${query}` : ""}`);
};
export const markNotificationsRead = (body) => request("/api/notifications/read", { method: "POST", body });

export const fetchPushStatus = () => request("/api/push-subscription");
export const savePushSubscription = (endpoint) => request("/api/push-subscription", { method: "POST", body: { endpoint } });
export const removePushSubscription = (endpoint) => request("/api/push-subscription", { method: "DELETE", body: { endpoint } });
