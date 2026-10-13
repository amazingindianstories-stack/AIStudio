"use client";

/** Promise-based text input dialog. Replaces window.prompt, which blocked the page. */
import { create } from "zustand";

export const useTextRequest = create(() => ({ request: null, hostMounted: false }));

export function askText({ title, label = "", defaultValue = "", placeholder = "", confirmLabel = "Save", optional = false, maxLength = 200 } = {}) {
  if (!useTextRequest.getState().hostMounted) {
    // No dialog host on this page: keep the old behaviour rather than silently dropping the action.
    if (typeof window === "undefined" || typeof window.prompt !== "function") return Promise.resolve(null);
    return Promise.resolve(window.prompt(title, defaultValue));
  }
  useTextRequest.getState().request?.resolve(null);
  return new Promise((resolve) => {
    useTextRequest.setState({ request: { title, label, defaultValue, placeholder, confirmLabel, optional, maxLength, resolve } });
  });
}

/** In-app confirmation. Resolves true only when the person confirms. */
export function askConfirm({ title, description = "", confirmLabel = "Confirm", destructive = false } = {}) {
  if (!useTextRequest.getState().hostMounted) {
    if (typeof window === "undefined" || typeof window.confirm !== "function") return Promise.resolve(false);
    return Promise.resolve(window.confirm(description ? `${title}\n\n${description}` : title));
  }
  useTextRequest.getState().request?.resolve(null);
  return new Promise((resolve) => {
    useTextRequest.setState({ request: { kind: "confirm", title, description, confirmLabel, destructive, resolve: (value) => resolve(value === true) } });
  });
}

export function settleTextRequest(value) {
  const { request } = useTextRequest.getState();
  if (!request) return;
  useTextRequest.setState({ request: null });
  request.resolve(value);
}
