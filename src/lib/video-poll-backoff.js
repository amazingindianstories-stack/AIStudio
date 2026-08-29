export const VIDEO_POLL_BASE_MS = 4_000;
export const VIDEO_POLL_MAX_MS = 60_000;

export function retryAfterMsForPollErrors(count) {
  const exponent = Math.max(0, Math.min(10, (Number(count) || 1) - 1));
  return Math.min(VIDEO_POLL_MAX_MS, VIDEO_POLL_BASE_MS * (2 ** exponent));
}

export function boundedVideoRetryAfterMs(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return VIDEO_POLL_BASE_MS;
  return Math.max(VIDEO_POLL_BASE_MS, Math.min(VIDEO_POLL_MAX_MS, Math.round(numeric)));
}

export function videoPollClientDecision(payload) {
  if (payload?.transientPollError === true) {
    const count = Math.max(1, Number(payload.pollErrorCount) || 1);
    return {
      transient: true,
      retryAfterMs: boundedVideoRetryAfterMs(payload.retryAfterMs),
      pollErrorCount: count,
      warning: `Provider status is temporarily unavailable. Retrying automatically (attempt ${count}).`,
    };
  }
  return {
    transient: false,
    retryAfterMs: VIDEO_POLL_BASE_MS,
    item: payload?.id ? { ...payload, pollWarning: undefined } : payload,
  };
}
