export const MAINTENANCE_MESSAGE = "Veevee is being updated. You can browse, but creating, uploading and organising are paused for a few minutes.";
export const MAINTENANCE_CODE = "MAINTENANCE";
export const MAINTENANCE_POLL_MS = 5000;

export function maintenanceBlocks(method, pathname) {
  const verb = method.toUpperCase();
  return pathname.startsWith("/api/") || pathname === "/api"
    ? !["GET", "HEAD"].includes(verb) && !(verb === "POST" && ["/api/auth/login", "/api/auth/logout"].includes(pathname))
    : false;
}

// A short, per-isolate cache bounds reads without retaining a stale ON value on
// errors. Never log the thrown error: SDK errors can contain the connection URL.
export function createMaintenanceReader(read, { now = Date.now, ttl = 5000, timeout = 2000, log = console.warn } = {}) {
  let cached, expires = 0, pending;
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
        cached = { enabled: value, available: true };
      } catch {
        log("[maintenance] Toggle unavailable; failing open (OFF).");
        cached = { enabled: false, available: false };
      } finally {
        clearTimeout(timer);
        expires = now() + ttl;
      }
      return cached;
    })();
    try { return await pending; } finally { pending = undefined; }
  };
}
