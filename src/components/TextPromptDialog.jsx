"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { settleTextRequest, useTextRequest } from "@/lib/ask-text";
import { ConfirmActionDialog } from "@/components/ConfirmActionDialog";

export function TextPromptDialog() {
  const request = useTextRequest((state) => state.request);
  const [value, setValue] = useState("");
  const titleId = useId();
  const inputRef = useRef(null);

  useEffect(() => {
    useTextRequest.setState({ hostMounted: true });
    return () => {
      settleTextRequest(null);
      useTextRequest.setState({ hostMounted: false });
    };
  }, []);

  useEffect(() => {
    if (!request || request.kind === "confirm") return undefined;
    setValue(request.defaultValue || "");
    const previousFocus = document.activeElement;
    const frame = requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.select(); });
    const onKeyDown = (event) => { if (event.key === "Escape") settleTextRequest(null); };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKeyDown);
      previousFocus?.focus?.();
    };
  }, [request]);

  if (!request || typeof document === "undefined") return null;
  if (request.kind === "confirm") {
    return <ConfirmActionDialog open title={request.title} description={request.description} confirmLabel={request.confirmLabel}
      destructive={request.destructive} onCancel={() => settleTextRequest(false)} onConfirm={() => settleTextRequest(true)} />;
  }
  const trimmed = value.trim();
  const canSubmit = request.optional || trimmed.length > 0;

  return createPortal(
    <div className="fixed inset-0 z-[220] grid place-items-center bg-black/65 p-4 backdrop-blur-sm"
      onMouseDown={(event) => { if (event.target === event.currentTarget) settleTextRequest(null); }}>
      <form role="dialog" aria-modal="true" aria-labelledby={titleId}
        className="w-full max-w-sm rounded-2xl border border-line bg-ink-750 p-5 shadow-pop"
        onSubmit={(event) => { event.preventDefault(); if (canSubmit) settleTextRequest(trimmed); }}>
        <h2 id={titleId} className="text-base font-semibold text-white">{request.title}</h2>
        <label className="mt-3 block text-xs text-white/60">
          {request.label && <span className="mb-1 block">{request.label}</span>}
          <input ref={inputRef} value={value} onChange={(event) => setValue(event.target.value)}
            maxLength={request.maxLength} placeholder={request.placeholder} aria-label={request.label || request.title}
            className="w-full rounded-lg border border-line bg-ink-900 px-3 py-2 text-sm text-white placeholder-white/30 focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand" />
        </label>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={() => settleTextRequest(null)}
            className="rounded-lg px-3 py-1.5 text-sm text-white/70 hover:bg-white/10 hover:text-white">Cancel</button>
          <button type="submit" disabled={!canSubmit}
            className="rounded-lg bg-brand px-3 py-1.5 text-sm font-semibold text-black disabled:opacity-40">{request.confirmLabel}</button>
        </div>
      </form>
    </div>,
    document.body
  );
}
