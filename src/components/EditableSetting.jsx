import { useId, useState } from "react";

/** Explicit, row-local commitment. Prop refreshes never discard an unsaved edit. */
export function EditableSetting({
  label,
  value,
  unit,
  min = 0,
  allowDefault = false,
  onSave,
}) {
  const id = useId();
  const [draft, setDraft] = useState(null);
  const [accepted, setAccepted] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  const baseline = accepted?.source === value ? accepted.value : value;
  const text = draft ?? String(baseline ?? "");
  const dirty = draft !== null && text !== String(baseline ?? "");
  const display = (v) =>
    v == null || v === "" ? "Global default" : `${v} ${unit || ""}`.trim();

  async function apply(event) {
    event.preventDefault();
    if (!dirty || busy) return;
    const next = allowDefault && !text.trim() ? null : Number(text);
    if (
      (!text.trim() && !allowDefault) ||
      (next !== null && (!Number.isSafeInteger(next) || next < min))
    ) {
      setMessage({
        error: true,
        text: `Enter a whole number of at least ${min}${allowDefault ? ", or leave blank for the global default" : ""}.`,
      });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      await onSave(next);
      setAccepted({ source: value, value: next });
      setDraft(null);
      setMessage({ text: "Saved" });
    } catch (error) {
      setMessage({
        error: true,
        text:
          error.message || "Could not save. Your edit is preserved; try again.",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={apply} className="space-y-2">
      <label htmlFor={id} className="sr-only">
        {label}
        {unit ? ` (${unit})` : ""}
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <input
          id={id}
          type="number"
          step="1"
          min={min}
          value={text}
          disabled={busy}
          placeholder={allowDefault ? "Global default" : undefined}
          onChange={(e) => {
            setDraft(e.target.value);
            setMessage(null);
          }}
          aria-describedby={`${id}-feedback`}
          className="w-32 rounded-lg border border-line bg-ink-700 px-3 py-2 text-sm text-white focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-50"
        />
        {unit && <span className="text-xs text-white/70">{unit}</span>}
        {dirty && (
          <>
            <button
              type="submit"
              disabled={busy}
              className="rounded-lg bg-white px-3 py-2 text-xs font-semibold text-ink-900 disabled:opacity-50"
            >
              {busy ? "Saving…" : "Apply"}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setDraft(null);
                setMessage(null);
              }}
              className="rounded-lg border border-line px-3 py-2 text-xs"
            >
              Cancel
            </button>
          </>
        )}
      </div>
      <div
        id={`${id}-feedback`}
        role="status"
        className={`text-xs ${message?.error ? "text-red-300" : "text-white/70"}`}
      >
        {message?.text ||
          (dirty ? `Unsaved: ${display(baseline)} → ${display(text)}` : "")}
      </div>
    </form>
  );
}
