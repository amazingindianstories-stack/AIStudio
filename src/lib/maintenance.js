export const MAINTENANCE_MESSAGE = "Veevee is being updated. You can browse, but creating, uploading and organising are paused for a few minutes.";
export const MAINTENANCE_CODE = "MAINTENANCE";
export const MAINTENANCE_POLL_MS = 5000;

// Exact POST paths that never write: sign-in/out and the read-only signed-URL lookup.
const UNFROZEN_POSTS = ["/api/auth/login", "/api/auth/logout", "/api/media-resolve"];

export function maintenanceBlocks(method, pathname) {
  const verb = method.toUpperCase();
  return pathname.startsWith("/api/") || pathname === "/api"
    ? !["GET", "HEAD"].includes(verb) && !(verb === "POST" && UNFROZEN_POSTS.includes(pathname))
    : false;
}

// A short, per-isolate cache bounds reads. A failed read keeps the isolate's
// last good value and fails open only when nothing was ever read. Never log the
// thrown error: SDK errors can contain the connection URL.
export function createMaintenanceReader(read, { now = Date.now, ttl = 5000, timeout = 2000, log = console.warn } = {}) {
  let cached, lastGood, expires = 0, pending;
  return async function readMaintenance() {
    if (cached && now() < expires) return cached;
    if (pending) return pending;
    pending = (async () => {
      let timer;
      try {
        const value = await Promise.race([
          read(),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), timeout); }),
        ]);
        if (typeof value !== "boolean") throw new Error("Missing boolean");
        cached = lastGood = { enabled: value, available: true };
      } catch {
        if (lastGood) {
          log(`[maintenance] Toggle unavailable; keeping last known state (${lastGood.enabled ? "ON" : "OFF"}).`);
          cached = { enabled: lastGood.enabled, available: false };
        } else {
          log("[maintenance] Toggle unavailable; failing open (OFF).");
          cached = { enabled: false, available: false };
        }
      } finally {
        clearTimeout(timer);
        expires = now() + ttl;
      }
      return cached;
    })();
    try { return await pending; } finally { pending = undefined; }
  };
}
