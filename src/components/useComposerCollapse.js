"use client";

import { useEffect, useRef, useState } from "react";
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
 * (menu, listbox, picker, preview, library, drag) is still active. */
export function useComposerCollapse({ overlayOpen = false, dragging = false } = {}) {
  const ref = useRef(null);
  const hasPointerRef = useRef(false);
  const filePickerOpenRef = useRef(false);
  const [collapsed, setCollapsed] = useState(true);
  const libraryOpen = useStore((s) => Boolean(s.assetLibraryOpen || s.portraitGalleryOpen));

  useEffect(() => {
    if (collapsed && ref.current) ref.current.scrollTop = 0;
  }, [collapsed]);

  const collapseIfIdle = () => {
    const root = ref.current;
    if (!root) return;
    const idle = shouldCollapseComposer({
      hasFocus: root.contains(document.activeElement),
      hasPointer: hasPointerRef.current,
      menuOpen: Boolean(root.querySelector('[aria-haspopup="menu"][aria-expanded="true"]') || document.querySelector('[role="menu"]')),
      dropdownOpen: Boolean(document.querySelector('[role="listbox"]') || overlayOpen || libraryOpen),
      filePickerOpen: filePickerOpenRef.current,
      dragging: dragging || Boolean(root.querySelector('[data-reference-strip-dragging="true"]')),
      previewOpen: Boolean(document.querySelector('[role="dialog"][aria-modal="true"]')),
    });
    if (idle) setCollapsed(true);
  };
  const collapseIfIdleRef = useRef(collapseIfIdle);
  collapseIfIdleRef.current = collapseIfIdle;

  // Native boundary events follow the DOM, so the pointer counts as outside while it is over a
  // portaled menu or preview and stays outside once that portal unmounts beneath it. React's
  // synthetic mouseleave follows the component tree and misses both.
  useEffect(() => {
    const root = ref.current;
    if (!root) return undefined;
    const enter = () => { hasPointerRef.current = true; };
    const leave = () => {
      hasPointerRef.current = false;
      collapseIfIdleRef.current();
    };
    root.addEventListener("mouseenter", enter);
    root.addEventListener("mouseleave", leave);
    return () => {
      root.removeEventListener("mouseenter", enter);
      root.removeEventListener("mouseleave", leave);
    };
  }, []);

  const shellProps = {
    ref,
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

  const collapseAfterSend = () => {
    hasPointerRef.current = false;
    if (ref.current?.contains(document.activeElement)) document.activeElement.blur?.();
    setCollapsed(true);
  };

  return { collapsed, shellProps, openFilePicker, collapseAfterSend };
}
