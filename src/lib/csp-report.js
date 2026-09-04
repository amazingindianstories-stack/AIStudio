export const MAX_CSP_REPORT_BYTES = 16 * 1024;
export const MAX_CSP_REPORTS = 20;

const ACCEPTED_CONTENT_TYPES = new Set([
  "application/csp-report",
  "application/reports+json",
]);

function boundedString(value, max = 200) {
  return typeof value === "string" ? value.slice(0, max) : undefined;
}

function documentRoute(value) {
  const raw = boundedString(value, 2_000);
  if (!raw) return undefined;
  try {
    const url = new URL(raw, "https://csp.invalid");
    const segments = url.pathname.split("/").filter(Boolean);
    if (!segments.length) return "/";
    // The application has only three document routes today. Unknown routes
    // are reduced to their first segment so a forged report cannot put an
    // object key, UUID, or other user-controlled path into logs.
    const candidate = `/${segments[0]}`;
    return ["/admin", "/login"].includes(candidate) ? candidate : `${candidate}/[redacted]`;
  } catch {
    return undefined;
  }
}

function sourceLocation(value) {
  const raw = boundedString(value, 2_000);
  if (!raw) return undefined;
  try {
    const url = new URL(raw, "https://csp.invalid");
    if (url.pathname.startsWith("/_next/static/")) return url.pathname.slice(0, 300);
    return ["http:", "https:"].includes(url.protocol) ? url.origin : url.protocol;
  } catch {
    return undefined;
  }
}

function blockedOriginOnly(value) {
  const raw = boundedString(value, 2_000);
  if (!raw) return undefined;
  if (["inline", "eval", "data", "blob", "self"].includes(raw)) return raw;
  try {
    const url = new URL(raw);
    return ["http:", "https:"].includes(url.protocol) ? url.origin : url.protocol;
  } catch {
    return "invalid";
  }
}

function integerInRange(value, min, max) {
  const number = Number(value);
  return Number.isInteger(number) && number >= min && number <= max ? number : undefined;
}

export function acceptedCspContentType(contentType) {
  const mediaType = String(contentType || "").split(";", 1)[0].trim().toLowerCase();
  return ACCEPTED_CONTENT_TYPES.has(mediaType);
}

export function sanitizeCspReport(input) {
  const body = input && typeof input === "object" ? input : {};
  const effectiveDirective = boundedString(
    body["effective-directive"] ?? body.effectiveDirective,
    100
  );
  const violatedDirective = boundedString(
    body["violated-directive"] ?? body.violatedDirective,
    100
  );
  const disposition = boundedString(body.disposition, 20);
  const statusCode = integerInRange(body["status-code"] ?? body.statusCode, 0, 599);
  const blockedOrigin = blockedOriginOnly(body["blocked-uri"] ?? body.blockedURL);
  const documentPath = documentRoute(body["document-uri"] ?? body.documentURL);
  const source = sourceLocation(body["source-file"] ?? body.sourceFile);

  return {
    event: "csp_violation",
    ...(effectiveDirective ? { effectiveDirective } : {}),
    ...(violatedDirective ? { violatedDirective } : {}),
    ...(disposition === "report" || disposition === "enforce" ? { disposition } : {}),
    ...(statusCode !== undefined ? { statusCode } : {}),
    ...(blockedOrigin ? { blockedOrigin } : {}),
    ...(documentPath ? { documentPath } : {}),
    ...(source ? { source } : {}),
  };
}

export function parseCspReports(raw, contentType) {
  if (!acceptedCspContentType(contentType)) {
    const error = new Error("Unsupported CSP report content type.");
    error.status = 415;
    throw error;
  }
  if (new TextEncoder().encode(raw).byteLength > MAX_CSP_REPORT_BYTES) {
    const error = new Error("CSP report payload is too large.");
    error.status = 413;
    throw error;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const error = new Error("Malformed CSP report JSON.");
    error.status = 400;
    throw error;
  }

  const entries = Array.isArray(parsed) ? parsed : [parsed];
  const reports = entries
    .filter((entry) => !entry?.type || entry.type === "csp-violation")
    .slice(0, MAX_CSP_REPORTS)
    .map((entry) => entry?.["csp-report"] ?? entry?.body ?? entry)
    .filter((entry) => entry && typeof entry === "object")
    .map(sanitizeCspReport);
  if (!reports.length) {
    const error = new Error("CSP report payload is empty.");
    error.status = 400;
    throw error;
  }
  return reports;
}
