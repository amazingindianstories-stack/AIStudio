"use client";

import { useEffect, useRef } from "react";

const FOCUSABLE =
  'button:not(:disabled), [href], input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';
const MODALS = '[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]';

// Open dialogs that use this hook, oldest first. Only the newest owns focus, so
// a confirmation opened over a viewer traps focus without the viewer fighting it.
const openDialogs = [];

const visible = (element) => !element.hidden && element.getClientRects().length > 0;

/**
 * One implementation of modal focus management: focus moves into the dialog on
 * open, Tab wraps inside it, focus that lands outside is pulled back, and focus
 * returns to the opener on close. Escape calls `onClose` when one is given.
 *
 * Options are read through a ref, so changing `onClose`, `returnFocusEl` or
 * `initialFocus` never re-runs the effect; only `open` does.
 *  - `returnFocusEl`: element, or function returning one, resolved on close;
 *    falls back to the element focused when the dialog opened.
 *  - `initialFocus`: function returning the element to focus first; falls back
 *    to the first enabled control, then the dialog itself (give it tabIndex -1).
 *
 * Pass an existing ref as `dialogRef`, or null to receive one as `{ ref }`.
 */
export function useModalFocus(dialogRef, { open = true, onClose, returnFocusEl, initialFocus } = {}) {
  const ownRef = useRef(null);
  const ref = dialogRef || ownRef;
  const optionsRef = useRef({});
  optionsRef.current = { onClose, returnFocusEl, initialFocus };

  useEffect(() => {
    const dialog = ref.current;
    if (!open || !dialog) return undefined;
    const previousFocus = document.activeElement;
    openDialogs.push(dialog);

    // Another modal (managed by this hook or not) opened after this one owns focus.
    const yielding = () => {
      if (openDialogs[openDialogs.length - 1] !== dialog) return true;
      return Array.from(document.querySelectorAll(MODALS)).some(
        (element) => element !== dialog && !element.contains(dialog) && !openDialogs.includes(element) && visible(element)
      );
    };
    const controls = () =>
      Array.from(dialog.querySelectorAll(FOCUSABLE)).filter((element) => !element.closest("[hidden], [inert]") && visible(element));
    const focusFirst = () => (controls()[0] || dialog).focus();

    const frame = requestAnimationFrame(() => {
      const preferred = optionsRef.current.initialFocus?.();
      if (preferred && !preferred.disabled && preferred.isConnected) preferred.focus();
      else focusFirst();
    });
    const onKeyDown = (event) => {
      if (event.defaultPrevented || yielding()) return;
      if (event.key === "Escape") {
        if (optionsRef.current.onClose) {
          event.preventDefault();
          optionsRef.current.onClose();
        }
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = controls();
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first) {
        event.preventDefault();
        dialog.focus();
      } else if (!dialog.contains(document.activeElement) || (event.shiftKey && document.activeElement === first)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    const onFocusIn = (event) => {
      if (!yielding() && !dialog.contains(event.target)) focusFirst();
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("focusin", onFocusIn);
      openDialogs.splice(openDialogs.indexOf(dialog), 1);
      const requested = optionsRef.current.returnFocusEl;
      const preferred = typeof requested === "function" ? requested() : requested;
      const target = preferred?.isConnected ? preferred : previousFocus;
      if (target?.isConnected) target.focus?.();
    };
  }, [open, ref]);

  return { ref };
}
