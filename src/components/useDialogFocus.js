import { useEffect } from "react";

export function useDialogFocus(ref, open) {
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement;
    const root = ref.current;
    if (!root) return;
    const controls = () =>
      [
        ...root.querySelectorAll(
          'button, a[href], input, textarea, select, summary, [tabindex="0"]',
        ),
      ].filter((el) => !el.disabled && el.getClientRects().length);
    (controls()[0] || root).focus();
    const trap = (event) => {
      // Nested confirmation dialogs own their focus until dismissed.
      if (event.key !== "Tab" || !root.contains(document.activeElement)) return;
      const list = controls();
      if (!list.length) {
        event.preventDefault();
        root.focus();
        return;
      }
      if (event.shiftKey && document.activeElement === list[0]) {
        event.preventDefault();
        list.at(-1).focus();
      } else if (!event.shiftKey && document.activeElement === list.at(-1)) {
        event.preventDefault();
        list[0].focus();
      }
    };
    root.addEventListener("keydown", trap);
    return () => {
      root.removeEventListener("keydown", trap);
      if (previous?.isConnected) previous.focus();
    };
  }, [ref, open]);
}
