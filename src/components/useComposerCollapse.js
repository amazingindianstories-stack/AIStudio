"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "@/lib/store";

export function shouldCollapseComposer({
  hasFocus = false,
  hasPointer = false,
  menuOpen = false,
  dropdownOpen = false,
  filePickerOpen = false,
  dragging = false,
  previewOpen = false,
} = {}) {
  if (menuOpen || dropdownOpen || filePickerOpen || dragging || previewOpen) {
    return false;
  }
  return !hasFocus && !hasPointer;
}

/** A composer shell starts collapsed, expands when its text field gains focus or the shell is
 * clicked, and collapses again once neither focus nor pointer is inside it and nothing it opened
 * (menu, picker, preview, library, drag) is still active. */
export function useComposerCollapse({ overlayOpen = false, dragging = false } = {}) {
  const ref = useRef(null);
  const hasPointerRef = useRef(false);
  const filePickerOpenRef = useRef(false);
  const sendFocusRef = useRef(null);
  const [collapsed, setCollapsed] = useState(true);
  const libraryOpen = useStore((s) => Boolean(s.assetLibraryOpen || s.portraitGalleryOpen));

  useEffect(() => {
    if (collapsed && ref.current) ref.current.scrollTop = 0;
  }, [collapsed]);

  const collapseIfIdleRef = useRef(null);
  const [pointerListeners] = useState(() => ({
    enter: () => { hasPointerRef.current = true; },
    leave: () => {
      hasPointerRef.current = false;
      collapseIfIdleRef.current();
    },
    recheck: () => collapseIfIdleRef.current(),
  }));

  const collapseIfIdle = () => {
    const root = ref.current;
    if (!root) return;
    const state = {
      hasFocus: root.contains(document.activeElement),
      hasPointer: hasPointerRef.current,
      menuOpen: Boolean(root.querySelector('[aria-haspopup="menu"][aria-expanded="true"]') || document.querySelector('[role="menu"]')),
      // The @tag listbox only lives while the prompt has focus and closes itself on blur, so it never blocks.
      dropdownOpen: Boolean(overlayOpen || libraryOpen),
      filePickerOpen: filePickerOpenRef.current,
      dragging: dragging || Boolean(root.querySelector('[data-reference-strip-dragging="true"]')),
      previewOpen: Boolean(document.querySelector('[role="dialog"][aria-modal="true"]')),
    };
    if (shouldCollapseComposer(state)) setCollapsed(true);
    else if (!state.hasFocus && !state.hasPointer) document.addEventListener("mousemove", pointerListeners.recheck, { once: true });
  };
  collapseIfIdleRef.current = collapseIfIdle;

  // Native boundary events follow the DOM, so the pointer counts as outside while it is over a
  // portaled menu or preview and stays outside once that portal unmounts beneath it. React's
  // synthetic mouseleave follows the component tree and misses both.
  const shellRef = useCallback((node) => {
    ref.current?.removeEventListener("mouseenter", pointerListeners.enter);
    ref.current?.removeEventListener("mouseleave", pointerListeners.leave);
    ref.current = node;
    hasPointerRef.current = false;
    node?.addEventListener("mouseenter", pointerListeners.enter);
    node?.addEventListener("mouseleave", pointerListeners.leave);
  }, [pointerListeners]);

  const shellProps = {
    ref: shellRef,
    "data-composer-collapsed": collapsed ? "true" : "false",
    onFocusCapture: (e) => {
      const tag = e.target?.tagName;
      if (tag === "TEXTAREA" || tag === "INPUT") setCollapsed(false);
    },
    onBlurCapture: (e) => {
      if (!ref.current?.contains(e.relatedTarget)) setTimeout(collapseIfIdle, 0);
    },
    onClick: (e) => {
      if (!e.target?.closest?.("button, [role='menuitem'], [role='option']")) setCollapsed(false);
    },
  };

  const openFilePicker = (inputRef) => {
    filePickerOpenRef.current = true;
    window.addEventListener("focus", () => {
      setTimeout(() => { filePickerOpenRef.current = false; }, 300);
    }, { once: true });
    inputRef.current?.click();
  };

  const collapseOnSend = () => {
    const focused = ref.current?.contains(document.activeElement) ? document.activeElement : null;
    sendFocusRef.current = focused;
    focused?.blur?.();
    setCollapsed(true);
  };
  const reopenAfterFailedSend = () => {
    const focused = sendFocusRef.current;
    sendFocusRef.current = null;
    setCollapsed(false);
    if (focused?.isConnected && (!document.activeElement || document.activeElement === document.body)) focused.focus();
  };

  return { collapsed, shellProps, openFilePicker, collapseOnSend, reopenAfterFailedSend };
}
