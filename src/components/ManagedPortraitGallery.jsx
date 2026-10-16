"use client";

import { useEffect, useRef } from "react";
import { Plus, Trash2, Users, X } from "lucide-react";
import { useStore } from "@/lib/store";
import { askConfirm } from "@/lib/ask-text";
import { notify } from "@/lib/notify";
import { cn } from "@/lib/utils";

const REFRESH_MS = 10000;
const TONES = {
  Ready: "bg-emerald-500/15 text-emerald-200 border-emerald-400/30",
  Preparing: "bg-sky-500/15 text-sky-200 border-sky-400/30",
  Checking: "bg-white/10 text-white/70 border-white/15",
  Removing: "bg-white/10 text-white/70 border-white/15",
  Failed: "bg-red-500/15 text-red-200 border-red-400/30",
};

export function relativeDuration(ms) {
  if (!Number.isFinite(ms)) return "";
  const minutes = Math.max(0, Math.floor(ms / 60000));
  if (minutes < 1) return "less than a minute";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

export function portraitLifetime(asset, now = Date.now()) {
  if (asset.inUse > 0) return `In use by ${asset.inUse} generation${asset.inUse === 1 ? "" : "s"} — kept until it finishes`;
  if (asset.label === "Ready" && asset.expiresAt) {
    const left = asset.expiresAt - now;
    return left > 0 ? `Removed in ${relativeDuration(left)} if unused` : "Being removed (unused)";
  }
  if (asset.label === "Preparing") return "Registering with BytePlus…";
  if (asset.label === "Failed") return "Could not be prepared. Delete it and try again.";
  return "";
}

export function ManagedPortraitGallery() {
  const s = useStore();
  const { assets, usage, loading, error } = s.managedPortraits;
  const load = s.loadManagedPortraits;
  const dialog = useRef(null);

  useEffect(() => {
    void load();
    const timer = setInterval(() => { if (typeof document === "undefined" || !document.hidden) void load(); }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  useEffect(() => {
    const trigger = document.activeElement;
    dialog.current?.focus();
    return () => { if (trigger?.isConnected) trigger.focus?.(); };
  }, []);

  const close = () => s.setPortraitGalleryOpen(false);
  const remove = async (asset) => {
    const confirmed = await askConfirm({ title: "Remove this portrait?", description: "It is removed from BytePlus. Your original image is kept and is used again automatically if a prompt needs it.", confirmLabel: "Remove", destructive: true });
    if (!confirmed) return;
    const result = await s.deleteManagedPortrait(asset.id);
    if (!result.ok) notify(result.error);
  };
  const addToPrompt = (asset) => {
    s.addReference(asset.imageUrl, "image", "Portrait");
    notify("Added to your prompt references.", { tone: "info" });
  };

  return (
    <div className="fixed inset-0 z-[60] grid place-items-center bg-black/75 p-3 backdrop-blur-sm" onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
      <section ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Portraits" onKeyDown={(e) => { if (e.key === "Escape") close(); }}
        className="flex h-[88dvh] w-full max-w-[1100px] flex-col overflow-hidden rounded-2xl border border-line bg-ink-850 text-white shadow-pop">
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-line px-4 py-3">
          <div>
            <h2 className="flex items-center gap-2 text-sm font-semibold"><Users size={16} />Portraits</h2>
            <p className="mt-0.5 text-xs text-white/55">
              Created automatically when a reference contains a face. Unused portraits are removed after {usage?.ttlHours ?? 4} hours; portraits in use are never removed.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {usage && (
              <span data-portrait-usage className="rounded-lg border border-line px-2 py-1 text-[11px] text-white/70">
                {usage.live} of {usage.observedCapacity ? Math.min(usage.capacity, usage.observedCapacity) : usage.capacity} stored · {usage.inUse} in use
              </span>
            )}
            <button type="button" aria-label="Close portraits" onClick={close} className="grid h-8 w-8 place-items-center rounded-lg hover:bg-white/10"><X size={16} /></button>
          </div>
        </header>
        {error && <p role="alert" className="px-4 py-2 text-xs text-red-300">{error}</p>}
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {loading && !assets.length ? (
            <p role="status" className="p-8 text-center text-sm text-white/50">Loading portraits…</p>
          ) : !assets.length ? (
            <p className="p-8 text-center text-sm text-white/50">No portraits yet. Add a reference with a face to a video prompt and it appears here automatically.</p>
          ) : (
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {assets.map((asset) => {
                const deletable = (asset.label === "Ready" || asset.label === "Failed") && !(asset.inUse > 0);
                return (
                  <li key={asset.id} data-managed-portrait={asset.id} className="overflow-hidden rounded-lg border border-line bg-ink-900">
                    <div className="relative aspect-[4/5] bg-ink-950">
                      {/* eslint-disable-next-line @next/next/no-img-element -- private media served by Django */}
                      {asset.imageUrl && <img src={asset.imageUrl} alt="" loading="lazy" className="h-full w-full object-cover" />}
                      <span className={cn("absolute left-2 top-2 rounded-full border px-2 py-0.5 text-[10px] font-semibold", TONES[asset.label] || TONES.Checking)}>{asset.label}</span>
                    </div>
                    <div className="space-y-1 p-2 text-[11px]">
                      <p className="text-white/80">{portraitLifetime(asset)}</p>
                      {asset.createdBy && <p className="truncate text-white/45">From {asset.createdBy}</p>}
                      <div className="flex gap-1 pt-1">
                        <button type="button" disabled={asset.label !== "Ready"} onClick={() => addToPrompt(asset)}
                          className="flex flex-1 items-center justify-center gap-1 rounded border border-line px-2 py-1 hover:bg-white/10 disabled:opacity-40"><Plus size={12} />Add to prompt</button>
                        <button type="button" disabled={!deletable} onClick={() => remove(asset)} aria-label="Remove portrait"
                          title={asset.inUse > 0 ? "In use by a generation — it can be removed when that finishes" : "Remove from BytePlus"}
                          className="grid w-8 place-items-center rounded border border-red-400/40 text-red-200 hover:bg-red-500/15 disabled:opacity-30"><Trash2 size={12} /></button>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}
