// Provider and gateway errors may be strings or structured envelopes.
// Extract only displayable messages; never stringify the full response.
// Machine codes (UPLOAD_NOT_READY, …) are translated, never shown raw.
const CODE_MESSAGES = {
  UNAUTHENTICATED: "Your session has ended. Sign in again.",
  UNAUTHORIZED: "Your session has ended. Sign in again.",
  FORBIDDEN: "You don't have permission to do that.",
  FORBIDDEN_ORIGIN: "This request was blocked. Reload the page and try again.",
  READ_ONLY_DATA_VIEWER: "Your account can view but not change data.",
  NOT_FOUND: "That item no longer exists.",
  ITEM_NOT_FOUND: "That item no longer exists.",
  PROJECT_NOT_FOUND: "That project no longer exists.",
  FOLDER_NOT_FOUND: "That folder no longer exists.",
  DESTINATION_NOT_FOUND: "The destination no longer exists.",
  EXPORT_NOT_FOUND: "That ZIP no longer exists.",
  VERSION_CONFLICT: "This was changed elsewhere. Refresh and try again.",
  DUPLICATE_FOLDER_NAME: "A folder with that name already exists here.",
  INVALID_NAME: "Enter a valid name.",
  FOLDER_NOT_EMPTY: "Empty the folder before deleting it.",
  PROJECT_NOT_EMPTY: "Empty the project before deleting it.",
  CYCLE_DETECTED: "A folder can't be moved inside itself.",
  CANNOT_MOVE_INTO_SELF: "A folder can't be moved inside itself.",
  EXCEEDS_MAX_DEPTH: "Folders can't be nested that deeply.",
  SUBTREE_TOO_LARGE: "That folder is too large to move at once.",
  INVALID_DESTINATION: "That destination isn't valid.",
  PROJECT_MISMATCH: "Those items belong to a different project.",
  SCOPE_MISMATCH: "Those items belong to a different project.",
  EXPORT_NOT_DRAFT: "That ZIP has already been queued.",
  INVALID_EXPORT_ITEMS: "Some selected items can't be added to a ZIP.",
  EXPIRED: "That link has expired. Try again.",
  ARCHIVE_UNAVAILABLE: "The ZIP isn't available. Build it again.",
  DOWNLOAD_UNAVAILABLE: "The download isn't available right now. Try again.",
  NOT_READY: "It isn't ready yet. Try again in a moment.",
  REQUEST_BODY_TOO_LARGE: "That request is too large.",
  UPLOAD_NOT_FOUND: "The upload couldn't be found. Upload the file again.",
  UPLOAD_NOT_READY: "The upload hasn't finished yet.",
  UPLOAD_CANCELLED: "The upload was cancelled. Upload the file again.",
  UPLOAD_EXPIRED: "The upload expired. Upload the file again.",
  UPLOAD_QUOTA_EXCEEDED: "Upload limit reached. Try again later.",
  UPLOAD_INFLIGHT_LIMIT: "Too many uploads at once. Wait for some to finish.",
  UPLOAD_TOO_LARGE_OR_EMPTY: "That file is empty or too large.",
  UPLOAD_SERVICE_UNAVAILABLE: "Uploads are unavailable right now. Try again shortly.",
  UPLOAD_PURPOSE_MISMATCH: "That file can't be used here.",
  INVALID_UPLOAD_CONTENT_TYPE: "That file type isn't supported.",
  INVALID_UPLOAD_PURPOSE_OR_TYPE: "That file type isn't supported here.",
  PREVIEW_PORTRAIT_GROUP_DELETE_REQUIRES_ARCHIVE: "Characters can't be deleted yet. Delete the portraits inside it instead.",
  PORTRAIT_IN_USE: "This portrait is being used by a generation right now. Try again when it finishes.",
  PORTRAITS_ARE_AUTOMATIC: "Portraits are created automatically from your references.",
  GENERATION_REQUIRES_RECONCILIATION: "This generation is still being checked with the provider. Try again later.",
};

const STATUS_MESSAGES = {
  401: CODE_MESSAGES.UNAUTHENTICATED,
  403: CODE_MESSAGES.FORBIDDEN,
  404: CODE_MESSAGES.NOT_FOUND,
  409: CODE_MESSAGES.VERSION_CONFLICT,
  413: "That file or request is too large.",
  429: "Too many requests. Wait a moment and try again.",
};

const CODE_PATTERN = /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$|^[A-Z]{4,}$/;
const MAX_LENGTH = 280;

function extract(value, depth = 0) {
  if (typeof value === "string") return value.trim();
  if (!value || typeof value !== "object" || depth > 3) return "";
  return extract(value.message, depth + 1) || extract(value.error, depth + 1);
}

function extractCode(value, depth = 0) {
  if (!value || typeof value !== "object" || depth > 3) return "";
  if (typeof value.code === "string" && CODE_MESSAGES[value.code]) return value.code;
  return extractCode(value.error, depth + 1);
}

function fromStatus(status, fallback) {
  if (STATUS_MESSAGES[status]) return STATUS_MESSAGES[status];
  if (fallback) return fallback;
  if (status >= 500) return "The server had a problem. Try again in a moment.";
  return status ? `Request failed (${status}).` : "Request failed.";
}

export function apiErrorMessage(body, status, fallback) {
  const code = extractCode(body);
  if (code) return CODE_MESSAGES[code];
  const text = extract(body);
  if (CODE_MESSAGES[text]) return CODE_MESSAGES[text];
  if (!text || CODE_PATTERN.test(text)) return fromStatus(status, fallback);
  return text.length > MAX_LENGTH ? `${text.slice(0, MAX_LENGTH - 1)}…` : text;
}
