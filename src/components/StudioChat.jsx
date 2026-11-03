"use client";
import { uploadOriginalReference, uploadFileDirect, uploadContentType } from "@/lib/client-reference-upload";


import {
  useEffect,
  useRef,
  useState,

} from "react";
import { motion } from "framer-motion";
import {
  AlertCircle,
  FileText,
  ImagePlus,
  Loader2,
  Mic,
  Send,
  Sparkles,
  Square,
  Wand2,
  X,
} from "lucide-react";
import { useStore } from "@/lib/store";

import { supportsVideoReference } from "@/lib/config";
import { measureAudioDuration } from "@/lib/audio-duration";
import { extractFrame } from "@/lib/video-frame";
import { ATTACH_ACCEPT, MAX_DOCUMENTS, documentType, uploadAgentDocument } from "@/lib/agent-attachments";
import { afterFailedSend } from "@/lib/agent-send";
import { insertTranscript, startVoiceNote, transcribeVoiceNote, voiceCaps, voiceErrorMessage } from "@/lib/voice-note";
import { formatTime } from "@/lib/canvas/talktrack";

import { SettingsToolbar } from "./ComposerControls";
import { ReferenceStrip, stagedReferenceCount, referenceSubmissionWarning } from "./PromptComposer";
import { useComposerCollapse } from "./useComposerCollapse";
import { getAssetDragData, isAssetDragEvent } from "@/lib/asset-drag-contract";
import { MentionTextarea, } from "./MentionTextarea";
import { GenerationFolderCue } from "./MediaCard";
import { MediaCard } from "./MediaCard";
import { GenerationStatus } from "./GenerationStatus";
import { Dropdown, MenuItem } from "./Dropdown";
import { normalizePromptMentions } from "@/lib/mentions";
import { cn } from "@/lib/utils";
import { apiErrorMessage } from "@/lib/api-error";

const GENERATE_TOOLS = new Set(["generate_image", "generate_video"]);
const IDLE_VOICE = { phase: "idle", elapsedMs: 0, maxMs: 0 };

/**
 * The merged chat + composer window for the Image and Video tabs — one
 * window per tab, chat-first, with the plain prompt/reference/settings
 * controls (ComposerControls) alongside it rather than stacked as a
 * separate block. Replaces ChatColumn + PromptComposer in page.tsx.
 *
 * The single input always goes to the orchestrator (POST
 * /api/agent-conversations/[id]/messages, scoped by agentKind=s.mode) —
 * the model decides whether to just talk, call design_prompt, or call
 * generate_{image,video}. A generate_* tool call is picked up here and
 * fires the exact same s.generate() the real Generate button always used,
 * so the result goes through the one existing queue/cost/polling path.
 *
 * `conversationId` is owned by StudioView (the parent) rather than here, so
 * ChatSidebar's thread list and this feed can't disagree about which thread
 * is open.
 */
export function StudioChat({ conversationId }) {
  const s = useStore();
  const mode = useStore((s) => s.mode);
  const model = useStore((s) => s.model);
  const setPrompt = useStore((s) => s.setPrompt);
  const generate = useStore((s) => s.generate);
  const referenceImages = useStore((s) => s.referenceImages);
  const addReference = useStore((s) => s.addReference);
  const addReferenceFromUrl = useStore((s) => s.addReferenceFromUrl);
  const addReferenceFromVideo = useStore((s) => s.addReferenceFromVideo);
  const items = useStore((s) => s.items);
  const threadItems = useStore((s) => s.threadItems);

  const [messages, setMessages] = useState([]);
  const [loadingThread, setLoadingThread] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const input = s.prompt;
  const setInput = s.setPrompt;
  const [pendingUploads, setPendingUploads] = useState(0);
  const [generatedItemIds, setGeneratedItemIds] = useState({});
  // Which messages we actually fired a generation for THIS page load — the
  // "Starting generation…" spinner is only honest for these. A message
  // loaded from history with a generate trace but no generatedItemId isn't
  // necessarily still running — it may be one from before generatedItemId
  // existed at all (nothing ever linked it), or a session that closed before
  // the PATCH landed. Either way we can't tell "running" from "orphaned", so
  // it must NOT spin forever claiming the former.
  const [liveMessageIds, setLiveMessageIds] = useState({});
  const [dragging, setDragging] = useState(false);
  const [extractingFrames, setExtractingFrames] = useState(0);
  // Documents staged for the next message, sent as `attachments` upload ids. /messages reads each one into the turn
  // as untrusted text (a PDF through one media sub-call) and records it on the conversation.
  const [documents, setDocuments] = useState([]);
  const documentsRef = useRef(documents);
  documentsRef.current = documents;
  // idle, starting (caps and microphone permission), recording or transcribing.
  const [voice, setVoice] = useState(IDLE_VOICE);
  const voiceRef = useRef(null);

  const scrollRef = useRef(null);
  const mentionRef = useRef(null);
  const fileRef = useRef(null);
  const requestIdRef = useRef(0);
  const { collapsed, shellProps: collapseProps, openFilePicker, collapseOnSend, reopenAfterFailedSend } = useComposerCollapse({ dragging });

  useEffect(() => {
    // Clear immediately, not just on the new fetch resolving — otherwise
    // switching threads in ChatSidebar briefly shows the PREVIOUS thread's
    // messages under the new one's name.
    setMessages([]);
    setGeneratedItemIds({});
    setLiveMessageIds({});
    setDocuments([]);
    if (!conversationId) return;
    const requestId = ++requestIdRef.current;
    setLoadingThread(true);
    (async () => {
      const res = await fetch(`/api/agent-conversations/${conversationId}`, { cache: "no-store" });
      const json = await res.json().catch(() => ({}));
      if (requestIdRef.current !== requestId) return;
      const loaded = json.messages ?? [];
      setMessages(loaded);
      // A reload has no in-memory record of which generation a past
      // generate_{image,video}/design_prompt message produced — read it back
      // from what the server persisted (see attachGeneratedItem), so a
      // finished generation shows its result instead of "Starting…" forever.
      const seeded = {};
      for (const m of loaded) {
        if (m.toolTrace?.generatedItemId) seeded[m.id] = m.toolTrace.generatedItemId;
      }
      setGeneratedItemIds(seeded);
      setLoadingThread(false);
    })();
  }, [conversationId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, sending]);

  useEffect(() => () => voiceRef.current?.cancel(), []);

  const findItem = (id) =>
    items.find((i) => i.id === id) ?? threadItems.find((i) => i.id === id);

  const fireGeneration = async (prompt, messageId) => {
    setPrompt(prompt);
    const created = await generate();
    if (created[0]) {
      setGeneratedItemIds((cur) => ({ ...cur, [messageId]: created[0].id }));
      if (conversationId) {
        // Best-effort: this is what makes the result survive a reload (see
        // the loader effect above). A failure here just means a refresh
        // would show "Generated — check your library" instead of the inline
        // card for this one message — not worth blocking or retrying over.
        fetch(`/api/agent-conversations/${conversationId}/messages/${messageId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ generatedItemId: created[0].id }),
        }).catch(() => {});
      }
    }
  };

  const send = async () => {
    const content = input.trim();
    if (!content || sending || pendingUploads || !conversationId) return;
    const optimistic = {
      id: `pending-${Date.now()}`,
      conversationId,
      role: "user",
      content,
      toolTrace: null,
      createdAt: Date.now(),
    };
    const sentDocuments = documentsRef.current;
    setMessages((cur) => [...cur, optimistic]);
    setError(null);
    setSending(true);
    collapseOnSend();
    try {
      const res = await fetch(`/api/agent-conversations/${conversationId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, images: referenceImages,
          ...(sentDocuments.length ? { attachments: sentDocuments.map((d) => d.uploadId) } : {}) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) {
        const kept = afterFailedSend({ status: res.status, data, optimisticId: optimistic.id, sentDocuments });
        if (kept) { setMessages(kept.messages); setDocuments(kept.documents); }
        throw new Error(apiErrorMessage(data, res.status));
      }
      const assistantMessage = data.assistantMessage;
      setDocuments((cur) => cur.filter((d) => !sentDocuments.includes(d)));
      setMessages((cur) => [...cur.filter((m) => m.id !== optimistic.id), data.userMessage, assistantMessage]);
      if (assistantMessage.toolTrace && GENERATE_TOOLS.has(assistantMessage.toolTrace.tool)) {
        setLiveMessageIds((cur) => ({ ...cur, [assistantMessage.id]: true }));
        const prompt = (assistantMessage.toolTrace.result )?.prompt;
        if (prompt) await fireGeneration(prompt, assistantMessage.id);
      }
    } catch (err) {
      reopenAfterFailedSend();
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setSending(false);
    }
  };

  // Stage originals through the metadata-only upload transport; provider caps
  // apply to generation, independently of the fifty-object draft workspace.
  const addImageFiles = async (files) => {
    setPendingUploads((count) => count + 1);
    try {
      let staged = documentsRef.current.length;
      for (const file of files) {
        if (documentType(file)) {
          if (staged >= MAX_DOCUMENTS) { setError(`A message can carry ${MAX_DOCUMENTS} documents. Remove one before adding more.`); break; }
          staged += 1;
          const attached = await uploadAgentDocument(file);
          setDocuments((cur) => [...cur, attached]);
          continue;
        }
        if (stagedReferenceCount(useStore.getState()) >= 50) { setError("The draft can stage fifty attachments. Remove an attachment before adding more."); break; }
        if (uploadContentType(file).startsWith("audio/")) {
          const [uploaded, duration] = await Promise.all([uploadFileDirect(file, "audio-reference"), measureAudioDuration(file)]);
          s.addAudioNote({ name: file.name, ref: uploaded.ref, ...(duration ? { duration } : {}) });
        } else if (uploadContentType(file).startsWith("video/") && mode === "video" && supportsVideoReference(model)) {
          const uploaded = await uploadFileDirect(file, "video-reference");
          s.addReferenceVideo(uploaded.ref, file.name);
        } else if (uploadContentType(file).startsWith("video/") || uploadContentType(file).startsWith("image/")) {
          if (uploadContentType(file).startsWith("video/")) {
            setExtractingFrames((count) => count + 1);
            try { const { dataUrl } = await extractFrame(file); const blob = await (await fetch(dataUrl)).blob(); addReference(await uploadOriginalReference(new File([blob], `${file.name}.jpg`, { type: blob.type })), "video", file.name); }
            finally { setExtractingFrames((count) => count - 1); }
          } else { addReference(await uploadOriginalReference(file), "image", file.name); }
        } else { setError(`Unsupported attachment: ${file.name}`); }
      }
    } catch (error) { setError(error.message || "Attachment upload failed. Please retry."); }
    finally { setPendingUploads((count) => count - 1); }
  };

  // Tap to record, tap again to stop; it also stops at the voice limit. The transcript goes into the draft for
  // review and is never sent by itself, and recording works while a reply is still on its way.
  const toggleVoice = async () => {
    if (voice.phase === "recording") { voiceRef.current?.stop(); return; }
    if (voice.phase !== "idle" || !conversationId) return;
    const id = conversationId;
    setError(null);
    setVoice({ ...IDLE_VOICE, phase: "starting" });
    try {
      const caps = await voiceCaps(id);
      const maxMs = caps.maxSeconds * 1000;
      const note = await startVoiceNote({ maxMs, onTick: (elapsedMs) => setVoice((cur) => (cur.phase === "recording" ? { ...cur, elapsedMs } : cur)) });
      voiceRef.current = note;
      setVoice({ phase: "recording", elapsedMs: 0, maxMs });
      const recording = await note.done;
      voiceRef.current = null;
      if (!recording) return;
      setVoice({ phase: "transcribing", elapsedMs: recording.durationMs, maxMs });
      const transcript = await transcribeVoiceNote(id, recording, { maxBytes: caps.maxBytes });
      if (transcript.trim()) setInput(insertTranscript(useStore.getState().prompt, transcript));
      else setError("No speech was heard in the voice note. Try again closer to the microphone.");
    } catch (err) {
      setError(voiceErrorMessage(err));
    } finally {
      voiceRef.current = null;
      setVoice(IDLE_VOICE);
    }
  };

  const onFiles = (e) => {
    addImageFiles(Array.from(e.target.files ?? []));
    e.target.value = "";
  };
  const onPaste = (e) => {
    const files = Array.from(e.clipboardData?.files ?? []).filter((f) => uploadContentType(f).startsWith("image/"));
    if (files.length) {
      e.preventDefault();
      addImageFiles(files);
    }
  };
  const dragEnterCountRef = useRef(0);
  const isFileDrag = (e) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
  const isAssetDrag = (e) => {
    return (
      isAssetDragEvent(e) ||
      Boolean(useStore.getState().draggedItem) ||
      Boolean(useStore.getState().draggedAssets?.length)
    );
  };
  const onDragEnter = (e) => {
    if (!isFileDrag(e) && !isAssetDrag(e)) return;
    dragEnterCountRef.current += 1;
    if (dragEnterCountRef.current === 1) {
      setDragging(true);
    }
  };
  const onDragOver = (e) => {
    if (!isFileDrag(e) && !isAssetDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    if (!dragging) setDragging(true);
  };
  const onDragLeave = (_e) => {
    dragEnterCountRef.current = Math.max(0, dragEnterCountRef.current - 1);
    if (dragEnterCountRef.current === 0) setDragging(false);
  };
  const addAssetReference = async (itemId) => {
    if (stagedReferenceCount(useStore.getState()) >= 50) { setError("The draft can stage fifty attachments. Remove one before adding more."); return; }
    const item = findItem(itemId);
    if (!item?.url) return;
    if (item.kind === "video") {
      await addReferenceFromVideo(item.url);
    } else {
      await addReferenceFromUrl(item.url);
    }
  };
  const onDrop = async (e) => {
    dragEnterCountRef.current = 0;
    setDragging(false);
    const assetPayload = getAssetDragData(e, useStore.getState());
    if (assetPayload.ids.length > 0) {
      e.preventDefault();
      for (const id of assetPayload.ids) {
        await addAssetReference(id);
      }
      return;
    }
    if (!isFileDrag(e)) return;
    e.preventDefault();
    addImageFiles(Array.from(e.dataTransfer.files));
  };

  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col"
      onPaste={onPaste}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {dragging && (
        <div className="pointer-events-none absolute inset-0 z-50 flex flex-col items-center justify-center gap-1.5 border-2 border-dashed border-brand/60 bg-ink-900/85 backdrop-blur-sm">
          <ImagePlus className="h-6 w-6 text-brand" />
          <p className="text-sm font-medium text-white/90">Drop to add as a reference</p>
        </div>
      )}

      {/* message feed */}
      <div ref={scrollRef} className="scroll-thin flex-1 overflow-y-auto px-4 py-6 sm:px-8">
        {!conversationId || loadingThread ? (
          <div className="mx-auto flex max-w-3xl items-center gap-2 text-sm text-white/40">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading chat…
          </div>
        ) : messages.length === 0 ? (
          <div className="mx-auto max-w-3xl text-sm leading-relaxed text-white/40">
            <p className="mb-1 flex items-center gap-1.5 font-medium text-white/60">
              <Sparkles className="h-4 w-4 text-brand" /> New chat
            </p>
            Talk through what you want to {mode === "image" ? "make" : "shoot"}. Attach reference
            images or documents if you have them, and say &quot;generate that&quot; when you are ready, or design a
            prompt first and generate it from here.
          </div>
        ) : (
          <div className="mx-auto flex max-w-3xl flex-col gap-4">
            {messages.map((m) => (
              <MessageBubble
                key={m.id}
                message={m}
                isLive={!!liveMessageIds[m.id]}
                generatedItemId={generatedItemIds[m.id]}
                generatedItem={generatedItemIds[m.id] ? findItem(generatedItemIds[m.id]) : undefined}
                onGenerate={(prompt) => fireGeneration(prompt, m.id)}
                onEditAndGenerate={(prompt) => setInput(prompt)}
              />
            ))}
            {sending && (
              <div className="mr-auto flex items-center gap-1.5 text-xs text-white/40">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Thinking…
              </div>
            )}
          </div>
        )}
      </div>

      {/* composer: the same floating rounded/blurred shell the pre-redesign
          PromptComposer used — refs above the input, settings below it,
          matching that layout instead of the flat bordered strip this had
          become. */}
      <div className="flex max-h-[50%] min-h-0 shrink-0 flex-col px-3 pb-3 pt-1 sm:px-8 sm:pb-5">
        <div
          {...collapseProps}
          data-testid="studio-chat-composer"
          className={cn(
            "composer-shell scroll-thin relative mx-auto flex min-h-0 w-full max-w-3xl flex-col gap-2 overflow-y-auto overscroll-y-contain rounded-2xl border border-line bg-ink-800/90 shadow-panel backdrop-blur-xl transition-[padding] duration-150",
            collapsed ? "px-2.5 py-1.5" : "p-2.5"
          )}
        >
          {extractingFrames > 0 && (
            <div className="flex items-center gap-2 rounded-lg bg-ink-750 px-3 py-2 text-xs text-white/70">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-brand" />
              Reading a frame from {extractingFrames} {extractingFrames === 1 ? "video" : "videos"}…
            </div>
          )}
          {error && (
            <div className="flex items-start gap-1.5 rounded-lg border border-red-500/30 bg-red-500/10 px-2.5 py-1.5 text-xs text-red-300">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {error}
            </div>
          )}

          <ReferenceStrip store={s} insertTag={(tag) => mentionRef.current?.insertTag(tag)} />
          {documents.length > 0 && (
            <ul aria-label="Attached documents" className="flex flex-wrap gap-1.5">
              {documents.map((d) => (
                <li key={d.uploadId} className="flex min-w-0 items-center gap-1 rounded-lg bg-ink-750 py-1 pl-2 pr-1 text-xs text-white/80">
                  <FileText className="h-3.5 w-3.5 shrink-0 text-white/50" />
                  <span className="max-w-[12rem] truncate">{d.name}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${d.name}`}
                    onClick={() => setDocuments((cur) => cur.filter((doc) => doc !== d))}
                    className="grid h-5 w-5 shrink-0 place-items-center rounded text-white/50 transition hover:bg-white/10 hover:text-white"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {referenceSubmissionWarning(s) && <p role="status" className="text-xs text-amber-200">{referenceSubmissionWarning(s)}</p>}
          {s.draftStorageWarning && <p role="status" className="text-xs text-amber-200">{s.draftStorageWarning}</p>}
          {normalizePromptMentions(input) !== input && <p role="status" className="text-xs text-amber-200">Some reference tags are informal. They remain literal text; use @img1 for an exact reference.</p>}
          <div className={cn("flex gap-3 text-xs text-white/60", collapsed && "hidden")}><button type="button" onClick={() => s.clearComposerDraft()}>New / Clear</button><button type="button" disabled={!s.recentSubmission} onClick={() => s.restoreRecentSubmission()}>Recent submission</button></div>

          <div className="flex items-start gap-2">
            <Dropdown
              side="top"
              trigger={(open) => (
                <span
                  className={cn(
                    "grid shrink-0 place-items-center rounded-xl border border-dashed border-white/15 text-white/55 transition-all hover:border-brand/40 hover:text-brand",
                    collapsed ? "h-[38px] w-[38px]" : "h-[58px] w-[58px]",
                    open && "border-brand/50 text-brand"
                  )}
                >
                  <span className="flex flex-col items-center gap-0.5">
                    <ImagePlus className="h-4 w-4" />
                    <span className={cn("text-[10px]", collapsed && "sr-only")}>reference</span>
                  </span>
                </span>
              )}
            >
              {(close) => (
                <MenuItem
                  onClick={() => {
                    openFilePicker(fileRef);
                    close();
                  }}
                >
                  <ImagePlus className="h-4 w-4 text-white/60" /> Upload image, video, audio or document
                </MenuItem>
              )}
            </Dropdown>
            <input ref={fileRef} type="file" accept={ATTACH_ACCEPT} multiple hidden onChange={onFiles} />

            <MentionTextarea
              ref={mentionRef}
              value={input}
              onChange={setInput}
              collapsed={collapsed}
              onSubmit={send}
              references={referenceImages}
              videoRefs={s.referenceVideos}
              audioRefs={s.audioNotes}
              placeholder={
                mode === "image"
                  ? "Talk through your idea, or type @ to reference an upload…"
                  : "Talk through your shot, or type @ to reference an upload…"
              }
            />
          </div>

          {pendingUploads > 0 && <p role="status" className="text-xs text-brand">Uploading attachments…</p>}
          {voice.phase === "recording" && <p role="status" className="text-xs text-red-200">Recording a voice note. It stops by itself at {formatTime(voice.maxMs)}.</p>}
          {voice.phase === "transcribing" && <p role="status" className="text-xs text-brand">Transcribing the voice note…</p>}
          <div className="flex min-w-0 items-center gap-2">
            <div className="min-w-0 flex-1">
              <SettingsToolbar />
            </div>
            <button
              type="button"
              onClick={toggleVoice}
              disabled={!conversationId || voice.phase === "starting" || voice.phase === "transcribing"}
              aria-pressed={voice.phase === "recording"}
              aria-label={voice.phase === "recording" ? "Stop recording and transcribe" : voice.phase === "transcribing" ? "Transcribing the voice note" : "Record a voice note"}
              title={voice.phase === "recording" ? "Stop recording" : "Record a voice note"}
              className={cn(
                "flex h-10 shrink-0 items-center justify-center gap-1.5 rounded-full transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60 disabled:cursor-not-allowed",
                voice.phase === "recording"
                  ? "bg-red-500/20 px-3 text-red-100 ring-1 ring-red-400/50 hover:bg-red-500/30"
                  : "w-10 bg-ink-650 text-white/60 hover:text-white disabled:text-white/30"
              )}
            >
              {voice.phase === "starting" || voice.phase === "transcribing" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : voice.phase === "recording" ? (
                <>
                  <Square className="h-3.5 w-3.5 fill-current" />
                  <span className="text-xs tabular-nums">{formatTime(voice.elapsedMs)} / {formatTime(voice.maxMs)}</span>
                </>
              ) : (
                <Mic className="h-4 w-4" />
              )}
            </button>
            <motion.button
              whileTap={{ scale: 0.92 }}
              onClick={send}
              disabled={sending || pendingUploads > 0 || !input.trim() || !conversationId}
              className={cn(
                "grid h-10 w-10 shrink-0 place-items-center rounded-full transition-all duration-200",
                input.trim() && !sending
                  ? "bg-gradient-to-br from-brand to-accent text-ink-900 shadow-glow hover:brightness-110"
                  : "cursor-not-allowed bg-ink-650 text-white/30"
              )}
              aria-label="Send"
            >
              {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            </motion.button>
          </div>
        </div>
      </div>
    </div>
  );
}

function MessageBubble({
  message,
  isLive,
  generatedItemId,
  generatedItem,
  onGenerate,
  onEditAndGenerate,
}

) {
  const isUser = message.role === "user";
  const trace = message.toolTrace;
  const designedPrompt = trace?.tool === "design_prompt" ? (trace.result )?.prompt : undefined;
  const isGenerateTrace = trace?.tool === "generate_image" || trace?.tool === "generate_video";
  const [generating, setGenerating] = useState(false);

  return (
    <div className={cn("flex flex-col gap-1.5", isUser ? "items-end" : "items-start")}>
      {generatedItem && <GenerationFolderCue item={generatedItem} />}
      {designedPrompt && (
        <span className="flex items-center gap-1 text-[11px] font-medium text-brand/80">
          <Wand2 className="h-3 w-3" /> Designed a prompt
        </span>
      )}
      <div
        className={cn(
          "max-w-[85%] whitespace-pre-wrap rounded-xl px-3 py-2 text-sm leading-relaxed",
          isUser ? "bg-brand/15 text-white" : "bg-white/6 text-white/85"
        )}
      >
        {message.content}
      </div>

      {/* Once a result exists (or one is in flight), the buttons have done
          their job — replaced by the result itself, same as clicking the
          real Generate button anywhere else in the app doesn't leave a
          second stale "Generate" control sitting around after. */}
      {designedPrompt && !generating && !generatedItemId && (
        <div className="flex gap-2">
          <button
            type="button"
            onClick={async () => {
              setGenerating(true);
              try {
                await onGenerate(designedPrompt);
              } finally {
                setGenerating(false);
              }
            }}
            className="flex items-center gap-1 rounded-full bg-brand/20 px-3 py-1 text-xs font-medium text-brand ring-1 ring-brand/40 transition hover:bg-brand/30"
          >
            Generate
          </button>
          <button
            type="button"
            onClick={() => onEditAndGenerate(designedPrompt)}
            className="rounded-full border border-line px-3 py-1 text-xs font-medium text-white/70 transition hover:text-white"
          >
            Edit and generate
          </button>
        </div>
      )}

      {/* Inline result — covers both ways a generation can start from this
          message: the model calling generate_{image,video} itself
          (isGenerateTrace), or the user clicking the Generate button above
          on a design_prompt reply (generating/generatedItem). Four states:
          resolved (card); known-but-not-loaded-locally (say so, don't spin);
          genuinely in flight THIS session (spinner — generating, or a fresh
          generate_* reply just received via send()); and — the case that
          was still broken — an OLD message with a generate trace but no
          generatedItemId that we did NOT just trigger ourselves. That isn't
          "still running", it's one from before generatedItemId existed (or
          a session that closed before the PATCH landed), and there is no
          way to tell those apart from here — so it must not claim either. */}
      {(isGenerateTrace || generating || generatedItemId) && (
        <div className="w-56">
          {generatedItem ? (
            <MediaCard item={generatedItem} />
          ) : generatedItemId ? (
            <div className="rounded-lg bg-ink-750 px-2.5 py-2 text-xs text-white/50">
              Generated — check your library to view it.
            </div>
          ) : generating || isLive ? (
            <GenerationStatus status="running" compact className="rounded-lg ring-1 ring-line" />
          ) : (
            <div className="rounded-lg bg-ink-750 px-2.5 py-2 text-xs text-white/50">
              Generation was requested — check your library for the result.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
