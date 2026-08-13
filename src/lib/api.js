// Frontend/backend origin split (Vercel frontend, Railway Django backend).
// Defaults to same-origin (empty base) so nothing changes until
// NEXT_PUBLIC_API_URL is actually set for a deployment. credentials:
// "include" is required once the API moves cross-origin (a same-origin
// request sends cookies regardless, so this is a no-op today).
export const API_BASE = (process.env.NEXT_PUBLIC_API_URL || "").replace(/\/$/, "");

export function apiUrl(path) {
  return `${API_BASE}${path}`;
}

export function apiFetch(path, options = {}) {
  return fetch(apiUrl(path), { credentials: "include", ...options });
}
