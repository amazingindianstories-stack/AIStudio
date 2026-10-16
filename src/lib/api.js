// Browser requests stay same-origin; Next transports /api directly to Django.
export const API_BASE = "";

export function apiUrl(path) {
  if (typeof path !== "string" || !path.startsWith("/api/") || path.includes("\\")) {
    throw new Error("API requests require a same-origin /api/ path");
  }
  const normalized = new URL(path, "https://same-origin.invalid");
  if (!normalized.pathname.startsWith("/api/") || normalized.pathname !== path.split(/[?#]/, 1)[0]) {
    throw new Error("API path must not traverse outside its endpoint");
  }
  return path;
}

export function apiFetch(path, options = {}) {
  return fetch(apiUrl(path), { credentials: "include", ...options });
}
