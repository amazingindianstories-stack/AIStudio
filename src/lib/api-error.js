// Provider and gateway errors may be strings or structured envelopes.
// Extract only displayable messages; never stringify the full response.
export function apiErrorMessage(body, status) {
  function message(value, depth = 0) {
    if (typeof value === "string") return value.trim();
    if (!value || typeof value !== "object" || depth > 3) return "";
    return message(value.message, depth + 1) || message(value.error, depth + 1);
  }
  return message(body) || `Server error: ${status}`;
}
