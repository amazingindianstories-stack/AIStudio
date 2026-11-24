"use client";
import { useMaintenance } from "@/lib/maintenance-client";

import { useEffect, useId, useRef } from "react";
import { useModalFocus } from "@/components/useModalFocus";
import { useModalLayer } from "@/components/modal-stack";
import { createPortal } from "react-dom";
import { AlertTriangle, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Shared safety boundary for media shortcuts. The caller owns the requested
 * action and its async state; this component owns modal accessibility and the
 * deliberately safe default focus on the dismiss button.
 */
export function ConfirmActionDialog({
  open,
  title,
  description,
  confirmLabel,
  dismissLabel = "Cancel",
  destructive = false,
  busy = false,
  maintenanceWrite = false,
  error = "",
  onCancel,
  onConfirm,
}) {
  const maintenance = useMaintenance((s) => s.enabled);
  const titleId = useId();
  const descriptionId = useId();
  const cancelRef = useRef(null);
  const dialogRef = useRef(null);
  useModalLayer(open);

  // Keyed on `open` alone: `busy` and `onCancel` change while the action runs
  // and must not restart the trap or restore focus to the page behind it.
  useModalFocus(dialogRef, { open, onClose: busy ? undefined : onCancel, initialFocus: () => cancelRef.current });

  // Cancel and Confirm disable while the action runs; keep focus on the dialog.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!busy || !dialog) return;
    const active = document.activeElement;
    if (!dialog.contains(active) || active.disabled) dialog.focus();
  }, [busy]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[220] grid place-items-center bg-black/65 p-4 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
    >
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        aria-busy={busy || undefined}
        tabIndex={-1}
        className="w-full max-w-sm outline-none rounded-2xl border border-line bg-ink-750 p-5 shadow-pop"
      >
        <div className="flex items-start gap-3">
          <span
            className={cn(
              "grid h-9 w-9 shrink-0 place-items-center rounded-xl",
              destructive ? "bg-red-500/15 text-red-300" : "bg-amber-400/15 text-amber-300"
            )}
          >
            <AlertTriangle className="h-4.5 w-4.5" />
          </span>
          <div className="min-w-0">
            <h2 id={titleId} className="text-sm font-semibold text-white">
              {title}
            </h2>
            <p id={descriptionId} className="mt-1.5 text-sm leading-5 text-white/60">
              {description}
            </p>
          </div>
        </div>
        {error && (
          <p role="alert" className="mt-3 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-200">
            {error}
          </p>
        )}
        <div className="mt-5 flex justify-end gap-2 border-t border-line pt-4">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-lg px-3 py-2 text-sm font-medium text-white/65 outline-none transition hover:bg-white/[0.07] hover:text-white focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-40"
          >
            {dismissLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy || (maintenanceWrite && maintenance)}
            className={cn(
              "flex min-w-24 items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-sm font-semibold outline-none transition focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-45",
              destructive
                ? "bg-red-500 text-white hover:bg-red-400"
                : "bg-white text-ink-900 hover:bg-white/90"
            )}
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

