/** Shared polling cadence: quick at first, slower for long jobs, backoff on errors. */

export const EXPORT_POLL_MAX_MS = 2 * 60 * 60 * 1000;

export function exportPollDelay(attempt, failures = 0) {
  if (failures > 0) return Math.min(5000 * 2 ** (failures - 1), 60000);
  if (attempt < 15) return 2000;
  if (attempt < 45) return 5000;
  return 15000;
}

/** Depth worker status only matters while depth mode is open; otherwise check rarely. */
export function depthStatusDelay(depthModeOpen) {
  return depthModeOpen ? 12000 : 60000;
}
