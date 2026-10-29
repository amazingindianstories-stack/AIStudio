import { apiFetch } from "./api";

/**
 * Board roles as the server reports them (`apps/canvas/access.py`): the
 * effective role is the highest of the board's team access, the user's board
 * membership, their project membership, board ownership and the admin role.
 * The server enforces every check; these helpers only shape the interface.
 */
const RANK = { view: 1, comment: 2, edit: 3, co_owner: 4, owner: 5 };

export const BOARD_ROLE_OPTIONS = [
  { value: "edit", label: "Can edit" },
  { value: "comment", label: "Can comment" },
  { value: "view", label: "Can view" },
];

export const PROJECT_ROLE_OPTIONS = [
  { value: "owner", label: "Owner" },
  { value: "co_owner", label: "Co-owner" },
  { value: "editor", label: "Editor" },
  { value: "commenter", label: "Commenter" },
  { value: "viewer", label: "Viewer" },
];

export const ROLE_LABELS = {
  owner: "Owner",
  co_owner: "Co-owner",
  edit: "Can edit",
  comment: "Can comment",
  view: "Can view",
};

const rank = (role) => RANK[role] ?? 0;

/** Unknown (not yet loaded) roles stay editable so loading never flashes a read-only UI. */
export const canEditRole = (role) => role == null || rank(role) >= RANK.edit;
export const canShareRole = (role) => rank(role) >= RANK.co_owner;
export const canOwnRole = (role) => rank(role) >= RANK.owner;

async function readJson(res) {
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Request failed: ${res.status}`);
  return json;
}

export async function fetchBoardAccess(boardId) {
  return readJson(await apiFetch(`/api/canvas-boards/${boardId}/access`, { cache: "no-store" }));
}

export async function changeBoardAccess(boardId, change) {
  return readJson(await apiFetch(`/api/canvas-boards/${boardId}/access`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(change),
  }));
}

export async function changeProjectMembers(projectId, change) {
  return readJson(await apiFetch(`/api/projects/${projectId}/members`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(change),
  }));
}

export async function fetchTeammates() {
  const json = await readJson(await apiFetch("/api/users", { cache: "no-store" }));
  return json.users ?? [];
}
