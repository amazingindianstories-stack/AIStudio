"use client";

import { useRef, useState } from "react";

/** One editor session owns one commit. Blur never retries a failed mutation. */
export function InlineFolderNameEditor({ initialName = "", label, onCommit, onClose }) {
  const [name, setName] = useState(initialName);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const state = useRef("editing");

  const commit = async (explicit = false) => {
    if (state.current !== "editing" && !(explicit && state.current === "failed")) return;
    const trimmed = name.trim();
    if (!trimmed || trimmed === initialName) {
      state.current = "closed";
      onClose();
      return;
    }
    state.current = "saving";
    setSaving(true);
    setError("");
    try {
      await onCommit(trimmed);
      state.current = "closed";
      onClose();
    } catch (err) {
      state.current = "failed";
      setError(err.code === "VERSION_CONFLICT"
        ? "Folder changed elsewhere. Review the updated folder and press Enter to retry."
        : err.message || "Could not save folder.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="min-w-0 flex-1" onClick={(e) => e.stopPropagation()}
      onSubmit={(e) => { e.preventDefault(); void commit(true); }}>
      <input autoFocus aria-label={label} aria-invalid={Boolean(error)}
        value={name} readOnly={saving}
        onChange={(e) => { setName(e.target.value); setError(""); }}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape" && state.current !== "saving") {
            e.preventDefault();
            state.current = "closed";
            onClose();
          }
        }}
        className="my-1 w-full rounded border border-brand/60 bg-ink-900 px-1 py-0.5 text-xs text-white outline-none focus:border-brand" />
      {error && <span role="alert" className="block text-[10px] text-red-400">{error}</span>}
    </form>
  );
}
