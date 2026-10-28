// Transport only. Django owns authentication and every /api method.
export function djangoOrigin(configuration = {}) {
  if (!configuration.origin) throw new Error("Django API origin is required");
  const origin = new URL(configuration.origin);
  if (origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) {
    throw new Error("Django API origin must be a bare origin");
  }
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname);
  if (origin.protocol !== "https:" && !(configuration.allowLocal === "1" && local && origin.protocol === "http:")) {
    throw new Error("Django API requires HTTPS");
  }
  return origin.origin;
}

// OAuth discovery documents for agent clients live at fixed site paths; Django serves them under /api/oauth.
export const WELL_KNOWN_DOCUMENTS = {
  "/.well-known/oauth-authorization-server": "/api/oauth/authorization-server",
  "/.well-known/oauth-protected-resource": "/api/oauth/protected-resource",
  "/.well-known/oauth-protected-resource/mcp": "/api/oauth/protected-resource",
};

export function djangoDestination(requestUrl, _method, configuration = {}) {
  const request = new URL(requestUrl);
  const document = Object.hasOwn(WELL_KNOWN_DOCUMENTS, request.pathname) ? WELL_KNOWN_DOCUMENTS[request.pathname] : null;
  if (!document && request.pathname !== "/api" && !request.pathname.startsWith("/api/")) return null;
  const origin = djangoOrigin(configuration);
  if (origin === request.origin) throw new Error("Django routing would loop");
  return new URL((document || request.pathname) + request.search, origin);
}

export async function fetchDjangoSession(cookieHeader, configuration = {}, fetchImpl = fetch) {
  const origin = djangoOrigin(configuration);
  const ingressSecret = configuration.ingressSecret;
  if (typeof ingressSecret !== "string" || ingressSecret.length < 48) {
    throw new Error("Private ingress unavailable");
  }
  // Only server configuration supplies ingress; no caller headers are copied.
  const cookie = (cookieHeader || "").split(";").filter((part) =>
    !["_vercel_jwt", "_vercel_protection_bypass"].includes(part.trim().split("=")[0])
  ).join(";");
  const response = await fetchImpl(`${origin}/api/auth/me`, {
    method: "GET",
    headers: { Cookie: cookie, "x-veevee-g4-ingress": ingressSecret },
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 401) return null;
  if (!response.ok) throw new Error("Django session lookup unavailable");
  return (await response.json()).user || null;
}
