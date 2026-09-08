import { useCallback, useEffect, useRef, useState } from "react";
import { AudioLines, Clipboard, Loader2, Upload, X } from "lucide-react";
import { apiFetch } from "@/lib/api";

export function AudioTranscriptionModal({ open, onClose, projectId }) {
  const [file, setFile] = useState(null);
  const [transcript, setTranscript] = useState("");
  const [history, setHistory] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef(null);

  const loadHistory = useCallback(async () => {
    const scope = projectId ? `&projectId=${encodeURIComponent(projectId)}` : "";
    const res = await apiFetch(`/api/history?kind=audio&limit=20${scope}`, { cache: "no-store" });
    if (!res.ok) return;
    const data = await res.json();
    setHistory(data.items || []);
  }, [projectId]);
  useEffect(() => {
    if (!open) return undefined;
    const task = queueMicrotask(() => { void loadHistory(); });
    return () => task;
  }, [open, loadHistory]);
  if (!open) return null;

  const transcribe = async () => {
    if (!file || busy) return;
    setBusy(true); setError(""); setTranscript("");
    try {
      if (!/^audio\/(mpeg|mp3|wav|x-wav|wave|ogg|webm|mp4|x-m4a|aac|flac)$/i.test(file.type)) throw new Error("Choose a common audio file such as MP3, WAV, M4A, OGG, AAC, FLAC or WebM.");
      if (file.size > 15 * 1024 * 1024) throw new Error("Audio files must be 15 MB or smaller.");
      const presignRes = await apiFetch("/api/uploads/presign", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ purpose: "audio-reference", contentType: file.type }) });
      const presign = await presignRes.json();
      if (!presignRes.ok) throw new Error(presign.error || "Could not start the upload.");
      const put = await fetch(presign.uploadUrl, { method: "PUT", headers: { "Content-Type": file.type }, body: file });
      if (!put.ok) throw new Error(`Upload failed (${put.status}).`);
      const ref = `/api/media/${presign.key}`;
      const res = await apiFetch("/api/audio/transcribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ audioRef: ref, name: file.name, projectId }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Transcription failed.");
      setTranscript(data.transcript || ""); setFile(null); await loadHistory();
    } catch (e) { setError(e.message || "Transcription failed."); }
    finally { setBusy(false); }
  };
  const copy = async (value) => { try { await navigator.clipboard.writeText(value); } catch {} };
  return (
    <div className="fixed inset-0 z-[80] grid place-items-center bg-black/70 p-4" role="dialog" aria-modal="true" aria-label="Audio transcription">
      <div className="flex max-h-[90vh] w-full max-w-6xl flex-col overflow-hidden rounded-2xl border border-line bg-ink-900 shadow-2xl">
        <div className="flex items-center justify-between border-b border-line px-5 py-4"><div className="flex items-center gap-2"><AudioLines className="h-5 w-5 text-brand" /><div><h2 className="font-semibold text-white">Audio transcription</h2><p className="text-xs text-white/50">Timestamped prompt-ready notes for Seedance</p></div></div><button onClick={onClose} aria-label="Close"><X className="h-5 w-5 text-white/60" /></button></div>
        <div className="grid min-h-0 gap-5 overflow-y-auto p-5 md:grid-cols-[minmax(220px,0.8fr)_minmax(300px,1.3fr)_minmax(220px,0.9fr)]">
          <div><input ref={inputRef} type="file" accept="audio/*" hidden onChange={(e) => setFile(e.target.files?.[0] || null)} /><button onClick={() => inputRef.current?.click()} className="flex min-h-36 w-full flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-line bg-ink-800 text-sm text-white/65 hover:border-brand/60"><Upload className="h-6 w-6" />{file ? <span className="max-w-full truncate px-4 text-brand">{file.name}</span> : <span>Choose MP3, WAV, M4A, OGG, AAC, FLAC or WebM</span>}</button>{file && <button onClick={transcribe} disabled={busy} className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl bg-brand px-4 py-2.5 text-sm font-semibold text-ink-900 disabled:opacity-50">{busy ? <><Loader2 className="h-4 w-4 animate-spin" /> Transcribing…</> : "Transcribe audio"}</button>}{error && <p className="mt-3 rounded-lg bg-red-500/10 p-3 text-xs text-red-200">{error}</p>}<p className="mt-4 text-xs leading-5 text-white/45">Gemini 1.5 Flash analyzes speech, music, ambience and sound effects. Transcripts are saved in your history for reuse in future Seedance prompts.</p></div>
          <div className="min-h-0">{transcript ? <div className="rounded-xl border border-brand/30 bg-ink-800 p-4"><div className="mb-2 flex items-center justify-between"><span className="text-xs font-semibold uppercase tracking-wide text-brand">Latest transcript</span><button onClick={() => copy(transcript)} className="flex items-center gap-1 text-xs text-white/60 hover:text-white"><Clipboard className="h-3.5 w-3.5" /> Copy</button></div><pre className="max-h-[55vh] overflow-auto whitespace-pre-wrap font-mono text-xs leading-5 text-white/85">{transcript}</pre></div> : <div className="rounded-xl border border-line bg-ink-800 p-4 text-sm text-white/45">Your timestamped transcript will appear here.</div>}</div>
          <aside className="min-h-0 rounded-xl border border-line bg-ink-800/60 p-3"><div className="mb-3 flex items-center justify-between"><h3 className="text-xs font-semibold uppercase tracking-wide text-white/60">Project history</h3><span className="text-[10px] text-white/35">{history.length}</span></div>{history.length ? <div className="max-h-[55vh] space-y-2 overflow-y-auto pr-1">{history.map((item) => <button key={item.id} onClick={() => setTranscript(item.productionMetadata?.transcript || item.prompt || "")} className="block w-full rounded-lg border border-line bg-ink-900 p-3 text-left hover:border-brand/40"><span className="block truncate text-xs text-white/75">{item.productionMetadata?.originalName || "Audio transcription"}</span><span className="mt-1 block line-clamp-3 whitespace-pre-wrap font-mono text-[11px] leading-4 text-white/45">{item.prompt}</span></button>)}</div> : <p className="text-xs text-white/35">No transcriptions in this project yet.</p>}</aside>
        </div>
      </div>
    </div>
  );
}
