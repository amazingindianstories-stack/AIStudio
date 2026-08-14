"use client";

import { useEffect, useRef, useState } from "react";
import { UploadCloud, Loader2, X, Users } from "lucide-react";
import { useStore } from "@/lib/store";
import { DEPTH_ENCODERS } from "@/lib/config";
import { cn } from "@/lib/utils";

const ENCODER_LABELS = {
  vits: { label: "Fast", hint: "Small model — quickest, lowest detail" },
  vitb: { label: "Balanced", hint: "Default — good detail at a reasonable speed" },
  vitl: { label: "Best", hint: "Large model — most detail, slowest (sized for a real GPU)" },
};

/**
 * The composer for depth-map jobs (mode="depth") — a different shape from
 * image/video's prompt + @tags + aspect-ratio/resolution pickers: a video
 * upload, an encoder choice, and an optional character-tracking toggle, sent
 * to a local worker rather than a cloud provider. See CLAUDE.md's "Depth-map
 * worker" section for the end-to-end architecture.
 */
export function DepthComposer() {
  const s = useStore();
  const status = s.depthWorkerStatus;
  const loadStatus = s.loadDepthWorkerStatus;
  const generateDepthMap = s.generateDepthMap;
  const generating = s.generating;

  const [file, setFile] = useState(null);
  const [encoder, setEncoder] = useState(DEPTH_ENCODERS[1]); // "vitb"
  const [trackCharacters, setTrackCharacters] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState(null);
  const fileRef = useRef(null);

  // TopBar owns the steady-state poll (it's mounted for the whole session,
  // depth mode or not) — this is just an extra immediate refresh so the
  // pill isn't showing a stale answer from before the user switched here.
  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  const online = status?.online === true;
  const checking = status === null;

  const pickFile = (f) => {
    if (!f) return;
    if (!f.type.startsWith("video/")) {
      setError("That's not a video file.");
      return;
    }
    setError(null);
    setFile(f);
  };

  const onDrop = (e) => {
    e.preventDefault();
    setDragging(false);
    pickFile(e.dataTransfer?.files?.[0]);
  };

  const submit = async () => {
    if (!file || uploading || generating) return;
    setUploading(true);
    setError(null);
    try {
      const presignRes = await fetch("/api/uploads/presign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ purpose: "depth-input", contentType: file.type }),
      });
      const presign = await presignRes.json();
      if (!presignRes.ok) throw new Error(presign.error || "Could not start the upload.");

      const putRes = await fetch(presign.uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": file.type },
        body: file,
      });
      if (!putRes.ok) throw new Error(`Upload failed (${putRes.status}).`);

      const item = await generateDepthMap({
        inputVideoKey: presign.key,
        encoder,
        trackCharacters,
        originalName: file.name,
      });
      if (item?.id) {
        setFile(null);
        setTrackCharacters(false);
      }
    } catch (e) {
      setError(e.message || "Failed to upload the video.");
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-3xl rounded-2xl border border-line bg-ink-800 p-4 shadow-lg sm:p-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-white">Depth map</h2>
          <p className="text-xs text-white/50">
            Runs on a local worker machine, not the cloud — see the status below.
          </p>
        </div>
        <StatusPill online={online} checking={checking} status={status} />
      </div>

      {!file ? (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          onClick={() => fileRef.current?.click()}
          className={cn(
            "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-line bg-ink-900/50 px-4 py-10 text-center transition-colors hover:border-lineStrong",
            dragging && "border-brand/60 bg-brand/5"
          )}
        >
          <UploadCloud className="h-6 w-6 text-white/40" />
          <p className="text-sm text-white/70">Drop a video here, or click to choose one</p>
          <input
            ref={fileRef}
            type="file"
            accept="video/*"
            className="hidden"
            onChange={(e) => pickFile(e.target.files?.[0])}
          />
        </div>
      ) : (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-line bg-ink-900/50 px-3 py-2.5">
          <span className="truncate text-sm text-white/85">{file.name}</span>
          <button
            type="button"
            onClick={() => setFile(null)}
            className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-white/50 hover:bg-white/10 hover:text-white"
            aria-label="Remove selected video"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-white/40">
            Quality
          </p>
          <div className="flex gap-1.5">
            {DEPTH_ENCODERS.map((enc) => (
              <button
                key={enc}
                type="button"
                onClick={() => setEncoder(enc)}
                title={ENCODER_LABELS[enc].hint}
                className={cn(
                  "rounded-lg px-2.5 py-1 text-xs font-medium transition-colors",
                  encoder === enc
                    ? "bg-brand/20 text-brand ring-1 ring-brand/40"
                    : "bg-ink-700 text-white/65 ring-1 ring-line hover:text-white"
                )}
              >
                {ENCODER_LABELS[enc].label}
              </button>
            ))}
          </div>
        </div>

        <label className="flex cursor-pointer items-center gap-2 pt-4 text-xs text-white/70">
          <input
            type="checkbox"
            checked={trackCharacters}
            onChange={(e) => setTrackCharacters(e.target.checked)}
            className="h-3.5 w-3.5 rounded border-line accent-brand"
          />
          <Users className="h-3.5 w-3.5 text-white/50" />
          Track characters
        </label>
      </div>

      {status?.currentJob && (
        <p className="mt-3 text-xs text-white/50">
          Worker is processing another job
          {typeof status.currentJob.progressPercent === "number"
            ? ` (${status.currentJob.progressPercent}%${
                status.currentJob.progressMessage ? ` — ${status.currentJob.progressMessage}` : ""
              })`
            : ""}
          {status.queueDepth > 0 ? ` — yours will queue behind it.` : "."}
        </p>
      )}

      {error && <p className="mt-3 text-xs text-red-400">{error}</p>}

      <button
        type="button"
        onClick={submit}
        disabled={!file || uploading || generating || !online}
        className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-brand py-2.5 text-sm font-semibold text-ink-900 transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
      >
        {uploading || generating ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" /> Starting…
          </>
        ) : !online ? (
          "Worker is offline"
        ) : (
          "Generate depth map"
        )}
      </button>
    </div>
  );
}

function StatusPill({ online, checking, status }) {
  return (
    <span
      className={cn(
        "flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium",
        checking
          ? "border-line text-white/40"
          : online
            ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
            : "border-red-500/30 bg-red-500/10 text-red-400"
      )}
      title={
        online
          ? `${status.workerCount} worker${status.workerCount === 1 ? "" : "s"} online, ${status.queueDepth} queued`
          : "No worker has checked in recently"
      }
    >
      <span
        className={cn(
          "h-1.5 w-1.5 rounded-full",
          checking ? "bg-white/40" : online ? "bg-emerald-400" : "bg-red-400"
        )}
      />
      {checking ? "Checking…" : online ? "Worker online" : "Worker offline"}
    </span>
  );
}
