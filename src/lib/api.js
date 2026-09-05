// Production points this build-time value at the authoritative Django API.
// The empty development default uses Vite's /api proxy. Cross-origin session
// cookies require credentials:"include" on every request.
export const API_BASE = (import.meta.env.VITE_API_URL || "").replace(/\/$/, "");

export function apiUrl(path) {
  return typeof path === "string" && path.startsWith("/api/") ? `${API_BASE}${path}` : path;
}

export function apiFetch(path, options = {}) {
  return fetch(apiUrl(path), { ...options, credentials: "include" });
}

const INVALID_RESPONSE = {
  code: "INVALID_RESPONSE",
  message: "Server returned an invalid response.",
};

function legacyError(body) {
  const value = body?.error;
  if (value && typeof value === "object") {
    return {
      code: typeof value.code === "string" ? value.code : "REQUEST_FAILED",
      message: typeof value.message === "string" ? value.message : "Request failed.",
    };
  }
  const message = typeof value === "string" ? value : "Request failed.";
  const code = /^[A-Z][A-Z0-9_]*$/.test(message) ? message : "REQUEST_FAILED";
  return { code, message };
}

export async function parseApiResponse(response) {
  let body;
  try {
    body = await response.json();
  } catch {
    return { ok: false, data: null, error: { ...INVALID_RESPONSE } };
  }
  if (body && typeof body === "object" && body.ok === true && "data" in body) {
    return response.ok
      ? { ok: true, data: body.data, error: null }
      : { ok: false, data: null, error: { ...INVALID_RESPONSE } };
  }
  if (body && typeof body === "object" && body.ok === false) {
    const error = body.error;
    if (response.ok || !error || typeof error.code !== "string" || typeof error.message !== "string") {
      return { ok: false, data: null, error: { ...INVALID_RESPONSE } };
    }
    return { ok: false, data: null, error: { code: error.code, message: error.message } };
  }
  if (response.ok) return { ok: true, data: body, error: null };
  return { ok: false, data: null, error: legacyError(body) };
}
