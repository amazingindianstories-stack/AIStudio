"use client";
import { uploadOriginalReference, uploadFileDirect, uploadContentType } from "@/lib/client-reference-upload";


import {
  useCallback,
  useEffect,
  useRef,
  useState,

} from "react";
import { motion } from "framer-motion";
import {
  AlertCircle,
  Clapperboard,
  FileText,
  Image as ImageIcon,
  ImagePlus,
  Loader2,
  Mic,
  Send,
  RotateCcw,
  Sparkles,
  Square,
  Undo2,
  Wand2,
  X,
} from "lucide-react";
import { uploadInlineReferences, useStore } from "@/lib/store";

import { modeAvailable, supportsVideoReference } from "@/lib/config";
import { composerContext, composerTag } from "@/lib/agent-composer";
import { MAGNIFIC_VIDEO_MAX_SECONDS } from "@/lib/magnific-ui";
import { measureAudioDuration } from "@/lib/audio-duration";
import { extractFrame } from "@/lib/video-frame";
import { ATTACH_ACCEPT, MAX_DOCUMENTS, documentType, uploadAgentDocument } from "@/lib/agent-attachments";
import { runView, threadEntries } from "@/lib/agent-run";
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
import { AgentRunPanel } from "./AgentRunPanel";
import { useAgentRun } from "./useAgentRun";
import { UpscaleSourceTile, UpscaleToolbar, useUpscaleSource } from "./AgentUpscaleControls";

const IDLE_VOICE = { phase: "idle", elapsedMs: 0, maxMs: 0 };

const MODE_TABS = [
  { id: "image", label: "Image", icon: ImageIcon },
  { id: "video", label: "Video", icon: Clapperboard },
  { id: "upscale", label: "Upscale", icon: Sparkles },
];

const SUBJECTS = { image: "idea", video: "shot", upscale: "upscale" };

const EMPTY_PROMPTS = {
  image: "Talk through the image you want to make. Attach references or documents if you have them, and say \"generate that\" when you are ready, or design a prompt first and generate it from here.",
  video: "Talk through the shot you want. Attach reference images, video, audio or documents if you have them, and say \"generate that\" when you are ready.",
  upscale: "Add the image or video to upscale with the source square below, or drag one in from your library, then say how you want it upscaled.",
};

/**
 * The Agents chat: one thread with the composer's mode tabs (Image, Video and
 * Upscale) inside it. A tab sets the store's `mode`, so the model and the
 * settings below the input are that mode's (ComposerControls for Image and
 * Video, AgentUpscaleControls for Upscale), and each message carries them as
 * its `composer` context (agent-composer.js) so the run follows them.
 *
 * The single input posts to the conversation's durable run (POST
 * /api/agent-conversations/[id]/runs): with no active run it starts one,
 * otherwise the message waits in that run's inbox and shows as queued until
 * the run reads it. The agent worker runs the model and its tools; useAgentRun
 * polls the run's event feed and AgentRunPanel renders its text, tool steps,
 * jobs, quote, pause and Stop controls. Jobs the run queues land in the chat's
 * folder like any generation, so their cards come from the same item pools.
 *
 * `conversationId` is owned by StudioView (the parent) rather than here, so
 * ChatSidebar's thread list and this feed can't disagree about which thread
 * is open.
 */
export function StudioChat({ conversationId }) {
  const s = useStore();
  const mode = useStore((s) => s.mode);
  const subject = SUBJECTS[mode] || "idea";
  const setMode = useStore((s) => s.setMode);
  const availableModelIds = useStore((s) => s.availableModelIds);
  const modeTabs = MODE_TABS.filter((tab) => tab.id !== "upscale" || modeAvailable("upscale", availableModelIds));
  const upscaling = mode === "upscale";
  const model = useStore((s) => s.model);
  const setPrompt = useStore((s) => s.setPrompt);
  const generate = useStore((s) => s.generate);
  const referenceImages = useStore((s) => s.referenceImages);
  const addReference = useStore((s) => s.addReference);
  const addReferenceFromUrl = useStore((s) => s.addReferenceFromUrl);
  const addReferenceFromVideo = useStore((s) => s.addReferenceFromVideo);
  const items = useStore((s) => s.items);
  const threadItems = useStore((s) => s.threadItems);
  const looseItems = useStore((s) => s.looseItems);

  const [messages, setMessages] = useState([]);
  const [loadingThread, setLoadingThread] = useState(true);
  const requestIdRef = useRef(0);
  // A run that ended re-reads the thread, so the saved messages (its replies and the messages it read) are authoritative.
  const refreshThread = useCallback(async () => {
    const id = conversationId;
    const requestId = requestIdRef.current;
    const res = await fetch(`/api/agent-conversations/${id}`, { cache: "no-store" }).catch(() => null);
    const json = res?.ok ? await res.json().catch(() => null) : null;
    if (json?.messages && requestIdRef.current === requestId) setMessages(json.messages);
  }, [conversationId]);
  const agentRun = useAgentRun(conversationId, { onSettled: refreshThread });
  const run = agentRun.state ? runView(agentRun.state) : null;
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const input = s.prompt;
  const setInput = s.setPrompt;
  const [pendingUploads, setPendingUploads] = useState(0);
  const [generatedItemIds, setGeneratedItemIds] = useState({});
  const [dragging, setDragging] = useState(false);
  const [extractingFrames, setExtractingFrames] = useState(0);
  // Documents staged for the next message, sent as `attachments` upload ids. The run's model is told each one's id,
  // kind and filename and opens it with read_document; the conversation records it.
  const [documents, setDocuments] = useState([]);
  const documentsRef = useRef(documents);
  documentsRef.current = documents;
  // idle, starting (caps and microphone permission), recording or transcribing.
  const [voice, setVoice] = useState(IDLE_VOICE);
  const voiceRef = useRef(null);
  const upload = useUpscaleSource({ onError: setError });

  const scrollRef = useRef(null);
  const feedRef = useRef(null);
  // Whether the feed follows its newest content; reading further up turns it off.
  const stickRef = useRef(true);
  const mentionRef = useRef(null);
  const fileRef = useRef(null);
  const { collapsed, shellProps: collapseProps, openFilePicker, collapseOnSend, reopenAfterFailedSend } = useComposerCollapse({ dragging });

  useEffect(() => {
    // Clear immediately, not just on the new fetch resolving — otherwise
    // switching threads in ChatSidebar briefly shows the PREVIOUS thread's
    // messages under the new one's name.
    setMessages([]);
    setGeneratedItemIds({});
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
      // design_prompt message produced (or an older generate_* one) - read it back
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
    stickRef.current = true;
  }, [conversationId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, sending, agentRun.state]);

  // Run feeds and job media arrive after the thread renders, so keep the
  // newest content in view while it grows unless the reader scrolled up.
  useEffect(() => {
    const feed = feedRef.current;
    if (!feed || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(() => {
      if (stickRef.current) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
    });
    observer.observe(feed);
    return () => observer.disconnect();
  }, []);

  useEffect(() => () => voiceRef.current?.cancel(), []);

  const findItem = (id) =>
    items.find((i) => i.id === id) ?? threadItems.find((i) => i.id === id) ?? looseItems.find((i) => i.id === id);

  // The thread: saved messages, with each run's activity after the message that started it (see threadEntries). Runs
  // that ended were read once when the chat opened; the current one follows its feed.
  const runs = agentRun.earlier.map((state) => ({ view: runView(state), synced: true, live: false }));
  if (run) runs.push({ view: run, synced: agentRun.synced, live: true });
  const thread = threadEntries(messages, runs);

  const fireGeneration = async (prompt, messageId) => {
    setPrompt(prompt);
    const created = await generate();
    if (created[0]) {
      setGeneratedItemIds((cur) => ({ ...cur, [messageId]: created[0].id }));
      if (conversationId) {
        // Best-effort: this is what makes the result survive a reload (see
        // the loader effect above). A failure here just means a refresh
        // would show "Generated. Check your library" instead of the inline
        // card for this one message — not worth blocking or retrying over.
        fetch(`/api/agent-conversations/${conversationId}/messages/${messageId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ generatedItemId: created[0].id }),
        }).catch(() => {});
      }
    }
  };

  // Reference images the draft still holds inline (data URLs) are uploaded first: the run only takes stored media.
  const storedReferenceImages = async () => {
    const state = useStore.getState();
    const references = state.referenceImages;
    const uploadOne = async (ref, label) => {
      const blob = await (await fetch(ref)).blob();
      return uploadOriginalReference(new File([blob], label, { type: blob.type }));
    };
    const stored = await uploadInlineReferences(references.map((value, i) => ({ value, label: state.referenceLabels?.[i] || "reference" })), uploadOne);
    if (useStore.getState().referenceImages === references && stored.some((value, i) => value !== references[i])) {
      useStore.setState({ referenceImages: stored });
    }
    return stored;
  };

  const send = async () => {
    const content = input.trim();
    if (!content || sending || pendingUploads || upload.uploading || !conversationId) return;
    const id = conversationId;
    const composer = composerContext(useStore.getState());
    const optimistic = {
      id: `pending-${Date.now()}`,
      conversationId: id,
      role: "user",
      content,
      composer,
      toolTrace: null,
      createdAt: Date.now(),
    };
    const sentDocuments = documentsRef.current;
    const requestId = requestIdRef.current;
    const moved = () => requestIdRef.current !== requestId;
    setError(null);
    setSending(true);
    collapseOnSend();
    let shown = false;
    try {
      const images = await storedReferenceImages();
      if (moved()) {
        reopenAfterFailedSend();
        return;
      }
      setMessages((cur) => [...cur, optimistic]);
      shown = true;
      // The sent text moves into the thread; a failed send puts it back.
      if (useStore.getState().prompt.trim() === content) setInput("");
      const res = await fetch(`/api/agent-conversations/${id}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, images,
          ...(composer ? { composer } : {}),
          ...(sentDocuments.length ? { attachments: sentDocuments.map((d) => d.uploadId) } : {}) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) throw new Error(apiErrorMessage(data, res.status));
      if (moved()) return;
      setDocuments((cur) => cur.filter((d) => !sentDocuments.includes(d)));
      if (data.delivery === "inbox") {
        setMessages((cur) => cur.filter((m) => m.id !== optimistic.id));
        agentRun.queue(data.inbox, data.run);
      } else {
        setMessages((cur) => cur.map((m) => (m.id === optimistic.id ? data.message : m)));
        agentRun.adopt(data.run, { fresh: true });
      }
    } catch (err) {
      reopenAfterFailedSend();
      if (moved()) return;
      if (shown) {
        setMessages((cur) => cur.filter((m) => m.id !== optimistic.id));
        if (!useStore.getState().prompt.trim()) setInput(content);
      }
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
    if (!files.length) return;
    e.preventDefault();
    if (upscaling && upload.media === "image") upload.selectFile(files[0]);
    else addImageFiles(files);
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
    if (upscaling && (assetPayload.items.length > 0 || assetPayload.ids.length > 0)) {
      // In Upscale the dropped asset is the source, as in the Upscale composer.
      e.preventDefault();
      upload.takeItems(assetPayload.items.length ? assetPayload.items : assetPayload.ids.map(findItem).filter(Boolean));
      return;
    }
    if (assetPayload.ids.length > 0) {
      e.preventDefault();
      for (const id of assetPayload.ids) {
        await addAssetReference(id);
      }
      return;
    }
    if (!isFileDrag(e)) return;
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files);
    const media = upscaling ? files.find((f) => /^(image|video)\//.test(uploadContentType(f))) : null;
    if (media) upload.selectFile(media);
    const rest = files.filter((f) => f !== media);
    if (rest.length) addImageFiles(rest);
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
          <p className="text-sm font-medium text-white/90">
            {upscaling ? `Drop to use as the ${upload.media} to upscale` : "Drop to add as a reference"}
          </p>
        </div>
      )}

      {/* message feed */}
      <div
        ref={scrollRef}
        data-testid="studio-chat-feed"
        onScroll={(e) => {
          const el = e.currentTarget;
          stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        }}
        className="scroll-thin flex-1 overflow-y-auto px-4 py-6 sm:px-8"
      >
        <div ref={feedRef}>
          {!conversationId || loadingThread ? (
            <div className="mx-auto flex max-w-3xl items-center gap-2 text-sm text-white/40">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading chat…
            </div>
          ) : messages.length === 0 && !run ? (
            <div data-testid="studio-chat-empty" className="mx-auto max-w-3xl">
              <p className="mb-1.5 flex items-center gap-1.5 text-sm font-medium text-white/75">
                <Sparkles className="h-4 w-4 text-brand" /> New chat
              </p>
              <p className="text-sm leading-relaxed text-white/45">{EMPTY_PROMPTS[mode] || EMPTY_PROMPTS.image}</p>
              <p className="mt-3 max-w-xl text-xs leading-relaxed text-white/35">
                One chat covers Image, Video and Upscale. Switch the tab in the composer and the model and settings
                follow; the agent works with the ones you sent. Open the activity line under a reply to see its steps,
                the settings it used and how long each took.
              </p>
            </div>
          ) : (
            <div className="mx-auto flex max-w-3xl flex-col gap-4">
              {thread.map((entry) => (entry.panel ? (
                <AgentRunPanel
                  key={`run-${entry.key}`}
                  view={entry.run.view}
                  items={entry.items}
                  last={entry.last}
                  synced={entry.run.synced}
                  findItem={findItem}
                  onDecide={(action, stepIndex) => agentRun.act(action, { stepIndex })}
                  onStop={(cancelJobs) => agentRun.act("cancel", { cancelJobs })}
                  pollError={entry.run.live && entry.last ? agentRun.pollError : null}
                />
              ) : (
                <MessageBubble
                  key={entry.message.id}
                  message={entry.message}
                  generatedItemId={generatedItemIds[entry.message.id]}
                  generatedItem={generatedItemIds[entry.message.id] ? findItem(generatedItemIds[entry.message.id]) : undefined}
                  onGenerate={(prompt) => fireGeneration(prompt, entry.message.id)}
                  onEditAndGenerate={(prompt) => setInput(prompt)}
                  canGenerate={!upscaling}
                />
              )))}
              {sending && (
                <div className="mr-auto flex items-center gap-1.5 text-xs text-white/40">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Sending…
                </div>
              )}
            </div>
          )}
        </div>
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
          <div className="flex min-w-0 items-center justify-between gap-2">
            <div role="tablist" aria-label="Mode" className="flex shrink-0 items-center gap-0.5 rounded-full bg-ink-900/80 p-0.5 ring-1 ring-line">
              {modeTabs.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={mode === id}
                  data-testid={`chat-mode-${id}`}
                  onClick={() => { if (mode !== id) setMode(id); }}
                  className={cn(
                    "flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60",
                    mode === id ? "bg-white/10 text-white ring-1 ring-white/15" : "text-white/50 hover:bg-white/5 hover:text-white"
                  )}
                >
                  <Icon className={cn("h-3.5 w-3.5", mode === id ? "text-brand" : "text-white/40")} />
                  {label}
                </button>
              ))}
            </div>
            <div className={cn("flex min-w-0 items-center gap-0.5", collapsed && "hidden")}>
              <button
                type="button"
                onClick={() => s.clearComposerDraft()}
                title="Clear the prompt and attachments"
                className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-white/45 transition hover:bg-white/5 hover:text-white/85"
              >
                <RotateCcw className="h-3 w-3" />
                <span className="hidden sm:inline">New / Clear</span>
                <span className="sr-only sm:hidden">New / Clear</span>
              </button>
              <button
                type="button"
                disabled={!s.recentSubmission}
                onClick={() => s.restoreRecentSubmission()}
                title="Restore the last submitted prompt"
                className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-white/45 transition hover:bg-white/5 hover:text-white/85 disabled:pointer-events-none disabled:opacity-40"
              >
                <Undo2 className="h-3 w-3" />
                <span className="hidden sm:inline">Recent submission</span>
                <span className="sr-only sm:hidden">Recent submission</span>
              </button>
            </div>
          </div>

          <div className="flex items-start gap-2">
            {upscaling && <UpscaleSourceTile upload={upload} collapsed={collapsed} />}
            <Dropdown
              className={cn(upscaling && "hidden")}
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
              placeholder={[
                `Talk through your ${subject}, or type @ to reference an upload…`,
                `Talk through your ${subject}, or @ an upload…`,
                `Talk through your ${subject}…`,
              ]}
            />
          </div>

          {pendingUploads > 0 && <p role="status" className="text-xs text-brand">Uploading attachments…</p>}
          {upscaling && upload.uploading && (
            <p role="status" className="truncate text-xs text-brand">
              Uploading {upload.uploading.name}{upload.uploading.progress == null ? "…" : ` (${upload.uploading.progress}%)`}
            </p>
          )}
          {upscaling && upload.tooLong && (
            <p role="alert" className="text-xs text-red-300">Videos longer than {MAGNIFIC_VIDEO_MAX_SECONDS} seconds cannot be upscaled. Choose a shorter one.</p>
          )}
          {voice.phase === "recording" && <p role="status" className="text-xs text-red-200">Recording a voice note. It stops by itself at {formatTime(voice.maxMs)}.</p>}
          {voice.phase === "transcribing" && <p role="status" className="text-xs text-brand">Transcribing the voice note…</p>}
          <div className="flex min-w-0 items-center gap-2">
            <div className="min-w-0 flex-1">
              {upscaling ? <UpscaleToolbar /> : <SettingsToolbar destination={false} />}
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
              disabled={sending || pendingUploads > 0 || Boolean(upload.uploading) || !input.trim() || !conversationId}
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
  generatedItemId,
  generatedItem,
  onGenerate,
  onEditAndGenerate,
  canGenerate,
}

) {
  const isUser = message.role === "user";
  const tag = isUser ? composerTag(message.composer) : null;
  const trace = message.toolTrace;
  const designedPrompt = trace?.tool === "design_prompt" ? (trace.result )?.prompt : undefined;
  const isGenerateTrace = trace?.tool === "generate_image" || trace?.tool === "generate_video";
  const [generating, setGenerating] = useState(false);

  return (
    <div className={cn("flex flex-col gap-1.5", isUser ? "items-end" : "items-start")}>
      {generatedItem && <GenerationFolderCue item={generatedItem} />}
      {tag && <span data-testid="message-composer-tag" className="text-[11px] text-white/40">{tag}</span>}
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
            disabled={!canGenerate}
            title={canGenerate ? undefined : "Switch to Image or Video to generate this prompt"}
            onClick={async () => {
              setGenerating(true);
              try {
                await onGenerate(designedPrompt);
              } finally {
                setGenerating(false);
              }
            }}
            className="flex items-center gap-1 rounded-full bg-brand/20 px-3 py-1 text-xs font-medium text-brand ring-1 ring-brand/40 transition hover:bg-brand/30 disabled:cursor-not-allowed disabled:opacity-40"
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

      {/* Inline result - covers both ways a generation could start from this
          message: an older reply where the model called generate_{image,video}
          itself (isGenerateTrace; runs show their jobs in AgentRunPanel), or the user clicking the Generate button above
          on a design_prompt reply (generating/generatedItem). Four states:
          resolved (card); known-but-not-loaded-locally (say so, don't spin);
          genuinely in flight THIS session (spinner - generating); and - the case that
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
              Generated. Check your library to view it.
            </div>
          ) : generating ? (
            <GenerationStatus status="running" compact className="rounded-lg ring-1 ring-line" />
          ) : (
            <div className="rounded-lg bg-ink-750 px-2.5 py-2 text-xs text-white/50">
              Generation was requested. Check your library for the result.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
