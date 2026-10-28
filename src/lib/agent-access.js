/** Display helpers for agent (MCP) access: Settings, the consent page and the admin limits. Django validates. */

export const SCOPE_TITLES = {
  "veevee.read": "Browse the library",
  "veevee.generate": "Create images and videos",
  "veevee.organize": "Organise the library",
  "veevee.admin": "Admin reports",
};

export const EXPIRY_CHOICES = [30, 90, 180, 365];

export function scopeTitle(scope) {
  return SCOPE_TITLES[scope] || scope;
}

export function dollars(cents) {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** "10", "10.5" or "$1,000.25" to whole cents; null when it is not a positive amount with at most two decimals. */
export function dollarsToCents(text) {
  const cleaned = String(text ?? "").trim().replace(/^\$/, "").replace(/,/g, "");
  if (!/^\d+(\.\d{0,2})?$/.test(cleaned)) return null;
  const cents = Math.round(Number(cleaned) * 100);
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

export function centsToDollarsText(cents) {
  return cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2);
}

/** Whole cents from 0 to `max`; null otherwise. */
export function wholeCents(text, max) {
  const cleaned = String(text ?? "").trim();
  if (!/^\d+$/.test(cleaned)) return null;
  const value = Number(cleaned);
  return value <= max ? value : null;
}

export function shortDate(ms) {
  return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function relativeTime(ms, now = Date.now()) {
  if (!ms) return "Never used";
  const minutes = Math.floor(Math.max(0, now - ms) / 60000);
  if (minutes < 1) return "Used just now";
  if (minutes < 60) return `Used ${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Used ${hours} h ago`;
  return `Used ${shortDate(ms)}`;
}

export function claudeCodeCommand(resource, token) {
  return `claude mcp add --transport http veevee ${resource} --header "Authorization: Bearer ${token}"`;
}

/** Where the consent decision sends the browser, shown before the user decides. */
export function redirectLabel(client) {
  return client.redirectHost || client.redirectUri;
}

export function verifiedHost(client) {
  if (!client.verifiedUrl) return null;
  try {
    return new URL(client.verifiedUrl).host;
  } catch {
    return null;
  }
}
