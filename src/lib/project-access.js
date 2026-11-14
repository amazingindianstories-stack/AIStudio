"use client";

/** Who may see a project; the server enforces it (`backend/apps/projects/visibility.py`). */
import { create } from "zustand";

export const PROJECT_ACCESS_OPTIONS = [
  { value: "all", label: "Everyone", hint: "Every signed-in user can see this project." },
  { value: "users", label: "Particular users", hint: "Only the people you pick, you and admins can see it." },
  { value: "admin", label: "Admin only", hint: "Only admins can see it. Everyone else gets no trace of it." },
];

export function projectAccessLabel(access) {
  return PROJECT_ACCESS_OPTIONS.find((option) => option.value === access)?.label ?? PROJECT_ACCESS_OPTIONS[0].label;
}

export const useProjectAccessRequest = create(() => ({ request: null, hostMounted: false }));

/**
 * Promise-based access dialog. With `name` it also asks for the project name (create); without it, only the access
 * (settings). Resolves `{ name?, access, accessUserIds }`, or null when cancelled.
 */
export function askProjectAccess({ title, confirmLabel = "Save", askName = false, name = "", access = "all", accessUserIds = [] } = {}) {
  if (!useProjectAccessRequest.getState().hostMounted) return Promise.resolve(null);
  useProjectAccessRequest.getState().request?.resolve(null);
  return new Promise((resolve) => {
    useProjectAccessRequest.setState({ request: { title, confirmLabel, askName, name, access, accessUserIds, resolve } });
  });
}

export function settleProjectAccess(value) {
  const { request } = useProjectAccessRequest.getState();
  if (!request) return;
  useProjectAccessRequest.setState({ request: null });
  request.resolve(value);
}
