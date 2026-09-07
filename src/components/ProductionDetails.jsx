import { useEffect, useState } from "react";
import { apiUrl, requestJson } from "@/lib/api";
import { useStore } from "@/lib/store";

const empty = {
  scene: "",
  shot: "",
  take: "",
  notes: "",
  reviewStatus: "candidate",
};
export function ProductionDetails({ item }) {
  const [record, setRecord] = useState(null);
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let canceled = false;
    requestJson(`/api/history/production?id=${encodeURIComponent(item.id)}`)
      .then((data) => {
        if (!canceled) {
          setRecord(data);
          setMessage("");
        }
      })
      .catch((error) => {
        if (!canceled) setMessage(error.message);
      });
    return () => {
      canceled = true;
    };
  }, [item.id, attempt]);
  const metadata =
    record?.item.productionMetadata || item.productionMetadata || {};
  const values = draft || { ...empty, ...metadata };
  const referenceNotes = [
    ...(item.referenceImages || []),
    ...(item.referenceVideos || []),
  ].map(
    (url) =>
      values.referenceNotes?.find((note) => note.url === url) || {
        url,
        label: "",
        approved: false,
      },
  );
  const save = async () => {
    setBusy(true);
    setMessage("");
    try {
      const body = Object.fromEntries(
        Object.keys(empty).map((key) => [key, values[key]]),
      );
      const data = await requestJson(
        `/api/history/production?id=${encodeURIComponent(item.id)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...body,
            referenceNotes,
            expectedRevision: metadata.revision || 0,
          }),
        },
      );
      setRecord(data);
      setDraft(null);
      setMessage("Saved");
      useStore.getState().updateInspectedItem(data.item);
      void useStore.getState().loadFeed();
      void useStore.getState().loadCounts();
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      className="mb-5 rounded-xl border border-line p-3 text-xs text-white/80"
      aria-label="Shot context and review"
    >
      <h3 className="mb-2 font-semibold text-white">
        Shot context &amp; review{" "}
        <span className="font-normal text-white/70">· optional</span>
      </h3>
      <div className="grid grid-cols-3 gap-2">
        {["scene", "shot", "take"].map((key) => (
          <label className="capitalize" key={key}>
            {key}
            <input
              disabled={!record || busy}
              maxLength={120}
              value={values[key]}
              onChange={(e) => setDraft({ ...values, [key]: e.target.value })}
              className="mt-1 w-full rounded border border-white/30 bg-ink-700 p-2"
            />
          </label>
        ))}
      </div>
      <label className="mt-2 block">
        Review notes
        <textarea
          disabled={!record || busy}
          maxLength={4000}
          value={values.notes}
          onChange={(e) => setDraft({ ...values, notes: e.target.value })}
          className="mt-1 w-full rounded border border-white/30 bg-ink-700 p-2"
        />
      </label>
      <label>
        Review state
        <select
          disabled={!record || busy}
          value={values.reviewStatus}
          onChange={(e) =>
            setDraft({ ...values, reviewStatus: e.target.value })
          }
          className="ml-2 rounded bg-ink-700 p-2"
        >
          <option value="candidate">Candidate</option>
          <option value="needs_changes">Needs changes</option>
          <option value="approved">Approved</option>
        </select>
      </label>
      {metadata.review && (
        <p className="mt-2">
          Reviewed by {metadata.review.reviewerName || "Team member"} ·{" "}
          {new Date(metadata.review.at).toLocaleString()}
        </p>
      )}
      {!!referenceNotes.length && (
        <details className="mt-3">
          <summary>
            Continuity references ·{" "}
            {referenceNotes.filter((note) => note.approved).length} approved
          </summary>
          <p className="my-2">
            Pin approved inputs for human continuity review. This does not
            enforce a model constraint.
          </p>
          {referenceNotes.map((note, index) => (
            <div className="mb-3" key={index}>
              <a
                href={apiUrl(note.url)}
                target="_blank"
                rel="noreferrer"
                className="underline"
              >
                Open reference {index + 1}
              </a>
              <label className="mt-1 block">
                Reference {index + 1} role
                <input
                  maxLength={120}
                  disabled={!record || busy}
                  className="mt-1 w-full rounded border border-white/30 bg-ink-700 p-2"
                  value={note.label}
                  onChange={(event) =>
                    setDraft({
                      ...values,
                      referenceNotes: referenceNotes.map((current, n) =>
                        n === index
                          ? { ...current, label: event.target.value }
                          : current,
                      ),
                    })
                  }
                />
              </label>
              <label className="mt-1 flex gap-2">
                <input
                  type="checkbox"
                  disabled={!record || busy}
                  checked={note.approved}
                  onChange={(event) =>
                    setDraft({
                      ...values,
                      referenceNotes: referenceNotes.map((current, n) =>
                        n === index
                          ? { ...current, approved: event.target.checked }
                          : current,
                      ),
                    })
                  }
                />
                Approved continuity reference {index + 1}
              </label>
              {note.reviewerName && <p>Approved by {note.reviewerName}</p>}
            </div>
          ))}
        </details>
      )}
      <div className="mt-2 flex gap-3">
        <button
          disabled={!draft || busy}
          onClick={save}
          className="rounded bg-white/10 px-3 py-2 disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save review"}
        </button>
        <button disabled={!draft || busy} onClick={() => setDraft(null)}>
          Cancel
        </button>
        <button disabled={busy} onClick={() => setAttempt((n) => n + 1)}>
          Reload latest
        </button>
      </div>
      {message && (
        <p role="status" className="mt-2">
          {message}
        </p>
      )}
      {metadata.sourceGenerationId && (
        <p className="mt-3">
          Origin: {metadata.relation}
          {metadata.frame && ` · ${metadata.frame} frame`} ·{" "}
          {record?.source ? (
            <button
              className="underline"
              onClick={() =>
                useStore.getState().openInspectedItem(record.source)
              }
            >
              Open source take
            </button>
          ) : (
            "Source unavailable"
          )}
        </p>
      )}
      {!!record?.children.length && (
        <div className="mt-2">
          Derived takes (up to 100):{" "}
          <div className="flex flex-wrap gap-2">
            {record.children.map((child, index) => (
              <button
                key={child.id}
                className="underline"
                onClick={() => useStore.getState().openInspectedItem(child)}
              >
                {child.productionMetadata?.take || `Take ${index + 1}`} ·{" "}
                {child.productionMetadata?.relation}
              </button>
            ))}
          </div>
        </div>
      )}
      {!!metadata.reviewHistory?.length && (
        <details className="mt-2">
          <summary>Review history</summary>
          {metadata.reviewHistory.map((review, index) => (
            <p key={index}>
              {review.status.replaceAll("_", " ")} ·{" "}
              {review.reviewerName || "Team member"} ·{" "}
              {new Date(review.at).toLocaleString()}
            </p>
          ))}
        </details>
      )}
    </section>
  );
}
