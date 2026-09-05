import {
  useEffect,
  useRef,
  useState,

} from "react";
import { motion } from "framer-motion";
import {
  AlertCircle,
  ImagePlus,
  Loader2,
  Send,
  Sparkles,
  Wand2,
} from "lucide-react";
import { useStore } from "@/lib/store";
import { maxReferenceImagesForVideoModel } from "@/lib/config";
import { extractFrame, isVideoFile } from "@/lib/video-frame";
import { REF_BATCH_BUDGET_BYTES, REF_BUDGET_STEPS, dataUrlBytes, downscaleBlob } from "@/lib/client-image-budget";
import { ReferenceStrip, SettingsToolbar } from "./ComposerControls";
import { Dropdown, MenuItem } from "./Dropdown";
import { MentionTextarea, } from "./MentionTextarea";
import { MediaCard } from "./MediaCard";
import { cn } from "@/lib/utils";
import { apiFetch } from "@/lib/api";

const GENERATE_TOOLS = new Set(["generate_image", "generate_video"]);

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
  const [input, setInput] = useState("");
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

  const scrollRef = useRef(null);
  const mentionRef = useRef(null);
  const fileRef = useRef(null);
  const requestIdRef = useRef(0);

  useEffect(() => {
    // Clear immediately, not just on the new fetch resolving — otherwise
    // switching threads in ChatSidebar briefly shows the PREVIOUS thread's
    // messages under the new one's name.
    setMessages([]);
    setGeneratedItemIds({});
    setLiveMessageIds({});
    if (!conversationId) return;
    const requestId = ++requestIdRef.current;
    setLoadingThread(true);
    (async () => {
      const res = await apiFetch(`/api/agent-conversations/${conversationId}`, { cache: "no-store" });
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
        apiFetch(`/api/agent-conversations/${conversationId}/messages/${messageId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ generatedItemId: created[0].id }),
        }).catch(() => {});
      }
    }
  };

  const send = async () => {
    const content = input.trim();
    if (!content || sending || !conversationId) return;
    const optimistic = {
      id: `pending-${Date.now()}`,
      conversationId,
      role: "user",
      content,
      toolTrace: null,
      createdAt: Date.now(),
    };
    setMessages((cur) => [...cur, optimistic]);
    setInput("");
    setError(null);
    setSending(true);
    try {
      const res = await apiFetch(`/api/agent-conversations/${conversationId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, images: referenceImages }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) throw new Error(data.error || `Request failed (${res.status}).`);
      const assistantMessage = data.assistantMessage;
      setMessages((cur) => [...cur.filter((m) => m.id !== optimistic.id), data.userMessage, assistantMessage]);
      if (assistantMessage.toolTrace && GENERATE_TOOLS.has(assistantMessage.toolTrace.tool)) {
        setLiveMessageIds((cur) => ({ ...cur, [assistantMessage.id]: true }));
        const prompt = (assistantMessage.toolTrace.result )?.prompt;
        if (prompt) await fireGeneration(prompt, assistantMessage.id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setSending(false);
    }
  };

  // Reference upload — same budget ladder PromptComposer used.
  const addImageFiles = async (files) => {
    const referenceFiles = files.filter(
      (file) => isVideoFile(file) || file.type.startsWith("image/")
    );
    const maxReferences =
      mode === "video" ? maxReferenceImagesForVideoModel(model) : null;
    const available =
      maxReferences === null
        ? referenceFiles.length
        : Math.max(0, maxReferences - referenceImages.length);
    const acceptedReferenceFiles = referenceFiles.slice(0, available);
    if (acceptedReferenceFiles.length < referenceFiles.length) {
      alert(
        `${model} accepts at most ${maxReferences} reference images. ` +
          `Only the first ${acceptedReferenceFiles.length} new reference${acceptedReferenceFiles.length === 1 ? " was" : "s were"} added.`
      );
    }
    const videos = acceptedReferenceFiles.filter(isVideoFile);
    if (videos.length) {
      setExtractingFrames(videos.length);
      for (const file of videos) {
        try {
          const { dataUrl } = await extractFrame(file);
          addReference(dataUrl);
        } catch (e) {
          console.error("Frame extraction failed", e);
          alert(e?.message || `Could not read a frame from ${file.name}.`);
        }
      }
      setExtractingFrames(0);
    }
    const valid = acceptedReferenceFiles.filter((f) => f.type.startsWith("image/"));
    if (!valid.length) return;
    let dataUrls = [];
    for (let i = 0; i < REF_BUDGET_STEPS.length; i++) {
      const { dim, quality } = REF_BUDGET_STEPS[i];
      const encoded = await Promise.all(
        valid.map(async (f) => {
          try {
            return await downscaleBlob(f, dim, quality);
          } catch (e) {
            console.error("Failed to downscale image", e);
            return null;
          }
        })
      );
      dataUrls = encoded.filter((u) => u !== null);
      if (!dataUrls.length) return;
      const totalBytes = dataUrls.reduce((n, u) => n + dataUrlBytes(u), 0);
      if (totalBytes <= REF_BATCH_BUDGET_BYTES || i === REF_BUDGET_STEPS.length - 1) break;
    }
    for (const dataUrl of dataUrls) addReference(dataUrl);
  };

  const onFiles = (e) => {
    addImageFiles(Array.from(e.target.files ?? []));
    e.target.value = "";
  };
  const onPaste = (e) => {
    const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith("image/"));
    if (files.length) {
      e.preventDefault();
      addImageFiles(files);
    }
  };
  const isFileDrag = (e) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
  // Same "text/itemId" payload ProjectPanel's drag-to-folder already sets on
  // asset cards (HistoryPanel now sets it too — see its renderItem) — the
  // browser lowercases DataTransfer type strings, so check lowercase here.
  const isAssetDrag = (e) =>
    Array.from(e.dataTransfer?.types ?? []).includes("text/itemid");
  const onDragOver = (e) => {
    if (!isFileDrag(e) && !isAssetDrag(e)) return;
    e.preventDefault();
    setDragging(true);
  };
  const onDragLeave = (e) => {
    if (!e.currentTarget.contains(e.relatedTarget )) setDragging(false);
  };
  const addAssetReference = async (itemId) => {
    const item = findItem(itemId);
    if (!item?.url) return;
    if (item.kind === "video") {
      await addReferenceFromVideo(item.url);
    } else {
      await addReferenceFromUrl(item.url);
    }
  };
  const onDrop = (e) => {
    setDragging(false);
    const itemId = e.dataTransfer.getData("text/itemId");
    if (itemId) {
      e.preventDefault();
      void addAssetReference(itemId);
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
            images if you have them, and say &quot;generate that&quot; when you are ready — or design a
            prompt first and generate it from here.
          </div>
        ) : (
          <div className="mx-auto flex max-w-3xl flex-col gap-4">
            {messages.map((m) => (
              <MessageBubble
                key={m.id}
                message={m}
                mode={mode}
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
      <div className="shrink-0 px-3 pb-3 pt-1 sm:px-8 sm:pb-5">
        <motion.div
          layout="size"
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ type: "spring", stiffness: 260, damping: 28 }}
          className="composer-shell relative mx-auto flex max-w-3xl flex-col gap-2 rounded-2xl border border-line bg-ink-800/90 p-2.5 shadow-panel backdrop-blur-xl"
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

          <ReferenceStrip onInsertTag={(tag) => mentionRef.current?.insertTag(tag)} />

          <div className="flex items-start gap-2">
            <Dropdown
              side="top"
              trigger={(open) => (
                <span
                  className={cn(
                    "grid h-[58px] w-[58px] shrink-0 place-items-center rounded-xl border border-dashed border-white/15 text-white/55 transition-colors hover:border-brand/40 hover:text-brand",
                    open && "border-brand/50 text-brand"
                  )}
                >
                  <span className="flex flex-col items-center gap-0.5">
                    <ImagePlus className="h-4 w-4" />
                    <span className="text-[10px]">reference</span>
                  </span>
                </span>
              )}
            >
              {(close) => (
                <MenuItem
                  onClick={() => {
                    fileRef.current?.click();
                    close();
                  }}
                >
                  <ImagePlus className="h-4 w-4 text-white/60" /> Upload image
                </MenuItem>
              )}
            </Dropdown>
            <input ref={fileRef} type="file" accept="image/*,video/*" multiple hidden onChange={onFiles} />

            <MentionTextarea
              ref={mentionRef}
              value={input}
              onChange={setInput}
              onSubmit={send}
              references={referenceImages}
              videoRefs={[]}
              placeholder={
                mode === "image"
                  ? "Talk through your idea, or type @ to reference an upload…"
                  : "Talk through your shot, or type @ to reference an upload…"
              }
            />
          </div>

          <div className="flex min-w-0 items-center gap-2">
            <div className="min-w-0 flex-1">
              <SettingsToolbar />
            </div>
            <motion.button
              whileTap={{ scale: 0.92 }}
              onClick={send}
              disabled={sending || !input.trim() || !conversationId}
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
        </motion.div>
      </div>
    </div>
  );
}

function MessageBubble({
  message,
  mode,
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
            <div className="flex items-center gap-1.5 rounded-lg bg-ink-750 px-2.5 py-2 text-xs text-white/50">
              <Loader2 className="h-3 w-3 animate-spin" /> Starting {mode} generation…
            </div>
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
