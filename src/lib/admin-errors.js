/** Formatting for the admin Errors tab: provider names, UTC/IST times and the support-ready block. */

export const PROVIDER_LABELS = {
  seedance: "Seedance (BytePlus ModelArk)",
  seedream: "Seedream (BytePlus ModelArk)",
  gemini: "Gemini (Google)",
  omni: "Gemini Omni (Google)",
  kling: "Kling",
  magnific: "Magnific",
  higgsfield: "Higgsfield",
  "byteplus-assets": "BytePlus asset library",
};

/** The table's compact name; the full one is in the details and the support block. */
export function providerShort(provider) {
  return providerLabel(provider).replace(/ \(.*\)$/, "");
}

export function providerLabel(provider) {
  return PROVIDER_LABELS[provider] || provider || "Unknown provider";
}

const pad = (value, size = 2) => String(value).padStart(size, "0");

function stamp(date) {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

/** "2026-10-19 10:20:12 UTC". */
export function formatUtc(ms) {
  return Number.isFinite(ms) ? `${stamp(new Date(ms))} UTC` : "";
}

/** India has no daylight saving: IST is always UTC+05:30. */
export function formatIst(ms) {
  return Number.isFinite(ms) ? `${stamp(new Date(ms + 330 * 60 * 1000))} IST` : "";
}

/** When the provider answered (its record), else when the job ended. */
export function errorTime(row) {
  return row.receivedAt ?? row.failedAt ?? row.createdAt;
}

/** What to show as the error: the provider's message, else the stored error text (older rows). */
export function errorText(row) {
  return row.message || row.error || "";
}

/** The block an admin pastes to the provider's support: one fact per line, empty facts left out. */
export function supportBlock(row) {
  const time = errorTime(row);
  const lines = [
    ["Provider", providerLabel(row.provider)],
    ["Model", row.model],
    ["Error code", row.code],
    ["Param", row.param],
    ["HTTP status", row.httpStatus],
    ["Request id", row.requestId],
    [row.source === "portrait" ? "Asset id" : "Task id", row.taskId],
    ["Message", errorText(row)],
    ["Time (UTC)", formatUtc(time)],
    ["Time (IST)", formatIst(time)],
    [row.source === "portrait" ? "Portrait asset" : "Generation id", row.id],
  ];
  return lines
    .filter(([, value]) => value !== null && value !== undefined && value !== "")
    .map(([label, value]) => `${label}: ${value}`)
    .join("\n");
}

/** Date input value (YYYY-MM-DD, local) to the epoch-ms bound the API filters created_at with. */
export function dayStart(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return null;
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day).getTime();
}

/** Exclusive upper bound: the start of the day after `value`. */
export function dayEnd(value) {
  const start = dayStart(value);
  if (start === null) return null;
  const date = new Date(start);
  date.setDate(date.getDate() + 1);
  return date.getTime();
}
