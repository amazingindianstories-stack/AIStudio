"use client";
import { useEffect } from "react";
import { useMaintenance } from "@/lib/maintenance-client";
import { MAINTENANCE_MESSAGE, MAINTENANCE_POLL_MS } from "@/lib/maintenance";

export function MaintenanceStatus({ children }) {
  const enabled = useMaintenance((s) => s.enabled);
  useEffect(() => {
    const controller = new AbortController();
    let pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try {
        const response = await fetch("/api/maintenance", { cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(4000)]) });
        if (!response.ok) throw new Error("Status unavailable");
        const value = await response.json();
        if (typeof value.enabled !== "boolean") throw new Error("Invalid status");
        if (!controller.signal.aborted) useMaintenance.setState({ enabled: value.enabled });
      } catch {
        // The middleware reports source failures as OFF too. A disconnected
        // browser keeps the last known state until the next successful poll.
      } finally { pending = false; }
    };
    void refresh();
    const timer = setInterval(refresh, MAINTENANCE_POLL_MS);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      controller.abort();
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);
  return <div data-maintenance-active={enabled ? "true" : undefined} className="flex h-[100dvh] flex-col overflow-hidden">
    {enabled && <div role="status" className="shrink-0 border-b border-amber-300/25 bg-amber-300/10 px-4 py-3 text-center text-sm text-amber-100">{MAINTENANCE_MESSAGE}</div>}
    <div className="min-h-0 flex-1 overflow-auto">{children}</div>
  </div>;
}

export function MaintenanceWriteBoundary({ children, className }) {
  const enabled = useMaintenance((s) => s.enabled);
  return <fieldset disabled={enabled} title={enabled ? MAINTENANCE_MESSAGE : undefined} className={className}>{children}</fieldset>;
}
