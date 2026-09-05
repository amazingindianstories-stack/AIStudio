import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Shared safety boundary for media shortcuts. The caller owns the requested
 * action and its async state; this component owns modal accessibility and the
 * deliberately safe default focus on Cancel.
 */
export function ConfirmActionDialog({
  open,
  title,
  description,
  confirmLabel,
  destructive = false,
  busy = false,
  error = "",
  onCancel,
  onConfirm,
}) {
  const titleId = useId();
  const descriptionId = useId();
  const cancelRef = useRef(null);
  const dialogRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const previousFocus = document.activeElement;
    let secondFrame = 0;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => cancelRef.current?.focus());
    });
    const onKeyDown = (event) => {
      if (event.key === "Escape" && !busy) onCancel();
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        dialogRef.current?.querySelectorAll(
          'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
        ) ?? []
      );
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(secondFrame);
      document.removeEventListener("keydown", onKeyDown);
      previousFocus?.focus?.();
    };
  }, [busy, onCancel, open]);

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
        className="w-full max-w-sm rounded-2xl border border-line bg-ink-750 p-5 shadow-pop"
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
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
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

