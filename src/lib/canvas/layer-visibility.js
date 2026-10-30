/**
 * Which layers this person hides on a board. Hiding is a personal view, like
 * Miro's, so it lives in this browser (per board) rather than in board data.
 */
const KEY_PREFIX = "veevee.board.hiddenLayers.";

export function readHiddenLayers(boardId) {
  if (!boardId) return [];
  try {
    const raw = JSON.parse(window.localStorage.getItem(KEY_PREFIX + boardId) ?? "[]");
    return Array.isArray(raw) ? raw.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

export function writeHiddenLayers(boardId, ids) {
  if (!boardId) return;
  try {
    if (ids.length) window.localStorage.setItem(KEY_PREFIX + boardId, JSON.stringify(ids));
    else window.localStorage.removeItem(KEY_PREFIX + boardId);
  } catch {
    /* storage unavailable: the choice lasts for this visit */
  }
}
