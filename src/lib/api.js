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

/**
 * Normalize canonical and pre-migration API responses without changing apiFetch.
 * Malformed JSON and invalid canonical envelopes become a predictable client error.
 */
export async function parseApiResponse(response) {
  let body;
  try {
    body = await response.json();
  } catch {
    return { ok: false, data: null, error: { ...INVALID_RESPONSE } };
  }

  if (body && typeof body === "object" && body.ok === true && "data" in body) {
    if (!response.ok) {
      return { ok: false, data: null, error: { ...INVALID_RESPONSE } };
    }
    return { ok: true, data: body.data, error: null };
  }

  if (body && typeof body === "object" && body.ok === false) {
    const error = body.error;
    if (
      response.ok ||
      !error ||
      typeof error !== "object" ||
      typeof error.code !== "string" ||
      typeof error.message !== "string"
    ) {
      return { ok: false, data: null, error: { ...INVALID_RESPONSE } };
    }
    return { ok: false, data: null, error: { code: error.code, message: error.message } };
  }

  if (response.ok) return { ok: true, data: body, error: null };
  return { ok: false, data: null, error: legacyError(body) };
}
