// Optional API origin override. Production currently uses the authoritative
// same-origin Next.js API, so the default remains empty. credentials:
// "include" also keeps cookie behavior correct for an explicitly configured
// compatible origin.
export const API_BASE = (process.env.NEXT_PUBLIC_API_URL || "").replace(/\/$/, "");

export function apiUrl(path) {
  return `${API_BASE}${path}`;
}

export function apiFetch(path, options = {}) {
  return fetch(apiUrl(path), { credentials: "include", ...options });
}
