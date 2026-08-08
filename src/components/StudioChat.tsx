"use client";

import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
} from "react";
import { motion } from "framer-motion";
import {
  AlertCircle,
  ChevronDown,
  ImagePlus,
  Layers,
  Loader2,
  Send,
  Sparkles,
  Wand2,
} from "lucide-react";
import { useStore } from "@/lib/store";
import { extractFrame, isVideoFile } from "@/lib/video-frame";
import { REF_BATCH_BUDGET_BYTES, REF_BUDGET_STEPS, dataUrlBytes, downscaleBlob } from "@/lib/client-image-budget";
import { ThreadSwitcher } from "./ThreadSwitcher";
import { ReferenceStrip, SettingsToolbar } from "./ComposerControls";
import { Dropdown, MenuItem } from "./Dropdown";
import { ProjectMenu } from "./ProjectMenu";
import { MentionTextarea, type MentionHandle } from "./MentionTextarea";
import { MediaCard } from "./MediaCard";
import { cn } from "@/lib/utils";
import type { AgentConversationMessage } from "@/lib/agents/orchestrator/types";
import type { GenerationItem } from "@/lib/types";

interface DisplayMessage extends AgentConversationMessage {
  pending?: boolean;
}

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
 */
export function StudioChat() {
  const mode = useStore((s) => s.mode);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const projects = useStore((s) => s.projects);
  const setPrompt = useStore((s) => s.setPrompt);
  const generate = useStore((s) => s.generate);
  const referenceImages = useStore((s) => s.referenceImages);
  const addReference = useStore((s) => s.addReference);
  const items = useStore((s) => s.items);
  const threadItems = useStore((s) => s.threadItems);

  const [conversationId, setConversationId] = useState<string | null>(null);
  const scopeRef = useRef<string | null>(null);
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [loadingThread, setLoadingThread] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [generatedItemIds, setGeneratedItemIds] = useState<Record<string, string>>({});
  const [dragging, setDragging] = useState(false);
  const [extractingFrames, setExtractingFrames] = useState(0);

  const scrollRef = useRef<HTMLDivElement>(null);
  const mentionRef = useRef<MentionHandle>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const requestIdRef = useRef(0);

  // Reset the thread whenever the project or tab changes — a stale thread
  // from a different project/mode must never be shown (mirrors CanvasView
  // holding boardId locally and resetting it the same way).
  useEffect(() => {
    const scope = `${activeProjectId}:${mode}`;
    if (scope !== scopeRef.current) {
      scopeRef.current = scope;
      setConversationId(null);
      setMessages([]);
    }
  }, [activeProjectId, mode]);

  useEffect(() => {
    if (!conversationId) return;
    const requestId = ++requestIdRef.current;
    setLoadingThread(true);
    (async () => {
      const res = await fetch(`/api/agent-conversations/${conversationId}`, { cache: "no-store" });
      const json = await res.json().catch(() => ({}));
      if (requestIdRef.current !== requestId) return;
      setMessages(json.messages ?? []);
      setLoadingThread(false);
    })();
  }, [conversationId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, sending]);

  const findItem = (id: string): GenerationItem | undefined =>
    items.find((i) => i.id === id) ?? threadItems.find((i) => i.id === id);

  const fireGeneration = async (prompt: string, messageId: string) => {
    setPrompt(prompt);
    const created = await generate();
    if (created[0]) {
      setGeneratedItemIds((cur) => ({ ...cur, [messageId]: created[0].id }));
    }
  };

  const send = async () => {
    const content = input.trim();
    if (!content || sending || !conversationId) return;
    const optimistic: DisplayMessage = {
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
      const res = await fetch(`/api/agent-conversations/${conversationId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, images: referenceImages }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) throw new Error(data.error || `Request failed (${res.status}).`);
      const assistantMessage: DisplayMessage = data.assistantMessage;
      setMessages((cur) => [...cur.filter((m) => m.id !== optimistic.id), data.userMessage, assistantMessage]);
      if (assistantMessage.toolTrace && GENERATE_TOOLS.has(assistantMessage.toolTrace.tool)) {
        const prompt = (assistantMessage.toolTrace.result as { prompt?: string })?.prompt;
        if (prompt) await fireGeneration(prompt, assistantMessage.id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setSending(false);
    }
  };

  // Reference upload — same budget ladder PromptComposer used.
  const addImageFiles = async (files: File[]) => {
    const videos = files.filter(isVideoFile);
    if (videos.length) {
      setExtractingFrames(videos.length);
      for (const file of videos) {
        try {
          const { dataUrl } = await extractFrame(file);
          addReference(dataUrl);
        } catch (e: any) {
          console.error("Frame extraction failed", e);
          alert(e?.message || `Could not read a frame from ${file.name}.`);
        }
      }
      setExtractingFrames(0);
    }
    const valid = files.filter((f) => f.type.startsWith("image/"));
    if (!valid.length) return;
    let dataUrls: string[] = [];
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
      dataUrls = encoded.filter((u): u is string => u !== null);
      if (!dataUrls.length) return;
      const totalBytes = dataUrls.reduce((n, u) => n + dataUrlBytes(u), 0);
      if (totalBytes <= REF_BATCH_BUDGET_BYTES || i === REF_BUDGET_STEPS.length - 1) break;
    }
    for (const dataUrl of dataUrls) addReference(dataUrl);
  };

  const onFiles = (e: ChangeEvent<HTMLInputElement>) => {
    addImageFiles(Array.from(e.target.files ?? []));
    e.target.value = "";
  };
  const onPaste = (e: ClipboardEvent) => {
    const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith("image/"));
    if (files.length) {
      e.preventDefault();
      addImageFiles(files);
    }
  };
  const isFileDrag = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
  const onDragOver = (e: DragEvent) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    setDragging(true);
  };
  const onDragLeave = (e: DragEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
  };
  const onDrop = (e: DragEvent) => {
    setDragging(false);
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
          <p className="text-sm font-medium text-white/90">Drop images to add as references</p>
        </div>
      )}

      {/* header: project switcher + thread switcher */}
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-2 sm:px-8">
        <Dropdown
          label="Switch project"
          trigger={(open) => {
            const proj = projects.find((p) => p.id === activeProjectId);
            return (
              <span
                className={cn(
                  "flex items-center gap-1.5 rounded-full border border-line bg-ink-700 px-3 py-1.5 text-sm text-white/85 transition hover:text-white",
                  open && "border-brand/40"
                )}
              >
                <Layers className="h-3.5 w-3.5 shrink-0 text-white/50" />
                <span className="max-w-[10rem] truncate">{proj ? proj.name : "No project"}</span>
                <ChevronDown className={cn("h-3.5 w-3.5 shrink-0 transition-transform", open && "rotate-180")} />
              </span>
            );
          }}
        >
          {(close) => <ProjectMenu close={close} />}
        </Dropdown>

        <ThreadSwitcher
          projectId={activeProjectId}
          agentKind={mode}
          conversationId={conversationId}
          onConversationIdChange={setConversationId}
        />
      </div>

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
            images if you have them, and say "generate that" when you're ready — or design a
            prompt first and generate it from here.
          </div>
        ) : (
          <div className="mx-auto flex max-w-3xl flex-col gap-4">
            {messages.map((m) => (
              <MessageBubble
                key={m.id}
                message={m}
                mode={mode}
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
  generatedItem,
  onGenerate,
  onEditAndGenerate,
}: {
  message: DisplayMessage;
  mode: "image" | "video";
  generatedItem?: GenerationItem;
  onGenerate: (prompt: string) => void;
  onEditAndGenerate: (prompt: string) => void;
}) {
  const isUser = message.role === "user";
  const trace = message.toolTrace;
  const designedPrompt = trace?.tool === "design_prompt" ? (trace.result as { prompt?: string })?.prompt : undefined;
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
      {designedPrompt && !generating && !generatedItem && (
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
          on a design_prompt reply (generating/generatedItem). */}
      {(isGenerateTrace || generating || generatedItem) && (
        <div className="w-56">
          {generatedItem ? (
            <MediaCard item={generatedItem} />
          ) : (
            <div className="flex items-center gap-1.5 rounded-lg bg-ink-750 px-2.5 py-2 text-xs text-white/50">
              <Loader2 className="h-3 w-3 animate-spin" /> Starting {mode} generation…
            </div>
          )}
        </div>
      )}
    </div>
  );
}
