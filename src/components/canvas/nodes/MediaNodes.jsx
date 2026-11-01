"use client";

import { useRef, useState } from "react";
import { Download, ExternalLink, FileText, Globe, ChevronLeft, ChevronRight, Link2, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { highlight, LANGUAGE_LABELS } from "@/lib/canvas/code-highlight";
import { ICONS } from "@/lib/canvas/icon-set";
import { PROVIDER_NAMES, classifyEmbed } from "@/lib/canvas/embeds";
import { toggleAgreement, setPdfPage } from "@/lib/canvas/media-actions";
import { currentUserId } from "@/lib/canvas/sticky-actions";

/** Controls inside a node must not start a drag of the node, which the node body does on pointer down. */
const stop = (e) => e.stopPropagation();

function TitleBar({ title, fallback }) {
  return (
    <div className="flex h-6 shrink-0 cursor-move items-center gap-1.5 truncate bg-black/55 px-2 text-[11px] text-white/75" data-media-title="">
      <span className="truncate">{title || fallback}</span>
    </div>
  );
}

function DownloadLink({ href, children = "Download original" }) {
  return (
    <a href={href} download onPointerDown={stop} className="inline-flex items-center gap-1 text-[11px] text-brand underline-offset-2 hover:underline">
      <Download className="h-3 w-3" aria-hidden />
      {children}
    </a>
  );
}

/**
 * Video that plays the stored master. A browser that cannot decode the master (a MOV in some browsers)
 * shows a native download instead; the bytes and file name are never transcoded or swapped.
 */
export function VideoNode({ node, selected }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className="flex h-full w-full flex-col overflow-hidden rounded-md bg-black shadow-[0_6px_16px_rgba(0,0,0,0.35)]" data-media="video">
      <TitleBar title={node.title} fallback="Video" />
      {failed ? (
        <div className="grid min-h-0 flex-1 place-items-center gap-1 p-3 text-center text-xs text-white/70" role="alert">
          <p>This browser cannot play this video.</p>
          <DownloadLink href={node.src} />
        </div>
      ) : (
        <video
          src={node.src}
          controls={selected}
          preload="metadata"
          playsInline
          muted={false}
          aria-label={node.title || "Video"}
          onError={() => setFailed(true)}
          onPointerDown={selected ? stop : undefined}
          className="min-h-0 w-full flex-1 bg-black object-contain"
        />
      )}
    </div>
  );
}

export function AudioNode({ node, selected }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className="flex h-full w-full flex-col overflow-hidden rounded-md border border-line bg-ink-750 shadow-[0_6px_16px_rgba(0,0,0,0.35)]" data-media="audio">
      <TitleBar title={node.title} fallback="Audio" />
      <div className="grid min-h-0 flex-1 place-items-center px-2">
        {failed ? (
          <DownloadLink href={node.src} />
        ) : (
          <audio
            src={node.src}
            controls
            preload="metadata"
            aria-label={node.title || "Audio"}
            onError={() => setFailed(true)}
            onPointerDown={selected ? stop : undefined}
            className="h-9 w-full"
          />
        )}
      </div>
    </div>
  );
}

/** One page of a PDF at a time: the page images were rendered by the worker next to the stored original. */
export function PdfNode({ node, selected }) {
  const page = Math.min(Math.max(node.page ?? 1, 1), node.pages);
  const go = (delta) => setPdfPage(node.id, page + delta);
  return (
    <div className="flex h-full w-full flex-col overflow-hidden rounded-md border border-line bg-white shadow-[0_6px_16px_rgba(0,0,0,0.35)]" data-media="pdf">
      <div className="flex h-6 shrink-0 cursor-move items-center gap-1.5 bg-black/70 px-2 text-[11px] text-white/80">
        <FileText className="h-3 w-3 shrink-0" aria-hidden />
        <span className="truncate">{node.name}</span>
      </div>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={`${node.src}.pages/${page}.png`} alt={`${node.name}, page ${page} of ${node.pages}`} draggable={false} loading="lazy" className="min-h-0 w-full flex-1 bg-white object-contain" />
      <div className="flex h-7 shrink-0 items-center justify-between gap-2 bg-ink-800 px-2 text-[11px] text-white/75" onPointerDown={selected ? stop : undefined}>
        <span className="flex items-center gap-1">
          <button type="button" aria-label="Previous page" disabled={page <= 1} onClick={() => go(-1)} className="grid h-5 w-5 place-items-center rounded hover:bg-white/10 disabled:opacity-30">
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
          <span data-pdf-page="">{`Page ${page} of ${node.pages}`}</span>
          <button type="button" aria-label="Next page" disabled={page >= node.pages} onClick={() => go(1)} className="grid h-5 w-5 place-items-center rounded hover:bg-white/10 disabled:opacity-30">
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </span>
        <DownloadLink href={node.src} />
      </div>
    </div>
  );
}

/**
 * A provider embed. Only an address that matches a provider rule is framed, in a sandbox without top
 * navigation, forms or downloads, with no referrer, so the frame can never reach the board's origin.
 */
export function EmbedNode({ node, selected }) {
  const found = classifyEmbed(node.src);
  if (!found) return <div className="grid h-full w-full place-items-center rounded-md border border-line bg-ink-750 text-xs text-white/60">This embed is not available.</div>;
  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden rounded-md border border-line bg-ink-800 shadow-[0_6px_16px_rgba(0,0,0,0.35)]" data-media="embed" data-provider={found.provider}>
      <div className="flex h-6 shrink-0 cursor-move items-center gap-1.5 bg-black/55 px-2 text-[11px] text-white/75">
        <Globe className="h-3 w-3 shrink-0" aria-hidden />
        <span className="truncate">{node.title || PROVIDER_NAMES[found.provider]}</span>
      </div>
      <iframe
        src={node.src}
        title={node.title || `${PROVIDER_NAMES[found.provider]} embed`}
        sandbox="allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox"
        referrerPolicy="no-referrer"
        loading="lazy"
        allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
        allowFullScreen
        className={cn("min-h-0 w-full flex-1 border-0 bg-black", !selected && "pointer-events-none")}
      />
    </div>
  );
}

/** A link preview card; the title opens the page in a new tab with no referrer. */
export function LinkCardNode({ node }) {
  return (
    <div className="flex h-full w-full flex-col overflow-hidden rounded-md border border-line bg-ink-750 shadow-[0_6px_16px_rgba(0,0,0,0.35)]" data-media="linkcard">
      {node.image && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={node.image} alt="" draggable={false} loading="lazy" className="min-h-0 w-full flex-1 bg-ink-800 object-cover" />
      )}
      <div className="flex shrink-0 flex-col gap-0.5 p-3">
        <div className="flex items-center gap-1.5 text-[11px] text-white/50">
          {node.favicon ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={node.favicon} alt="" width={14} height={14} draggable={false} className="h-3.5 w-3.5 rounded-sm" />
          ) : (
            <Link2 className="h-3.5 w-3.5" aria-hidden />
          )}
          <span className="truncate">{node.site || new URL(node.url).hostname}</span>
        </div>
        <a href={node.url} target="_blank" rel="noopener noreferrer nofollow" onPointerDown={stop} className="line-clamp-2 text-sm font-medium text-white hover:underline">
          {node.title || node.url}
        </a>
        {node.description && <p className="line-clamp-2 text-xs text-white/55">{node.description}</p>}
      </div>
    </div>
  );
}

const TOKEN_CLASS = { keyword: "text-sky-300", string: "text-emerald-300", number: "text-amber-300", comment: "text-white/40 italic", plain: "" };

/** Code with highlighting, optional line numbers and a copy button. Text only: no markup is built from code. */
export function CodeNode({ node, selected }) {
  const [copied, setCopied] = useState(false);
  const lines = node.code.split("\n");
  const tokens = highlight(node.code, node.language);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(node.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="flex h-full w-full flex-col overflow-hidden rounded-md border border-line bg-[#14161b] shadow-[0_6px_16px_rgba(0,0,0,0.35)]" data-media="code">
      <div className="flex h-6 shrink-0 cursor-move items-center justify-between bg-black/45 px-2 text-[11px] text-white/60">
        <span>{LANGUAGE_LABELS[node.language] ?? "Plain text"}</span>
        {selected && (
          <button type="button" onPointerDown={stop} onClick={copy} aria-label="Copy code" className="flex items-center gap-1 rounded px-1 hover:bg-white/10">
            {copied ? <Check className="h-3 w-3" /> : null}
            {copied ? "Copied" : "Copy"}
          </button>
        )}
      </div>
      <div className="flex min-h-0 flex-1 overflow-auto font-mono leading-snug text-white/85" style={{ fontSize: node.fontSize }}>
        {node.lineNumbers && (
          <pre aria-hidden className="select-none border-r border-white/10 px-2 py-2 text-right text-white/30">
            {lines.map((_, i) => i + 1).join("\n")}
          </pre>
        )}
        <pre className="m-0 whitespace-pre px-3 py-2" data-code-text="">
          {tokens.map((token, i) => (
            <span key={i} className={TOKEN_CLASS[token.kind]}>{token.text}</span>
          ))}
        </pre>
      </div>
    </div>
  );
}

/** An emoji or sticker. An interactive one counts who clicked it to agree; clicking again takes it back. */
export function EmojiNode({ node, readOnly }) {
  const down = useRef(null);
  const user = currentUserId();
  const agreed = node.agreedBy ?? [];
  const mine = user ? agreed.includes(user) : false;
  const sticker = node.style === "sticker";
  return (
    <div
      className={cn("relative grid h-full w-full place-items-center", sticker && "rounded-2xl bg-white/90 shadow-[0_4px_10px_rgba(0,0,0,0.4)] ring-4 ring-white")}
      style={{ transform: node.rotation ? `rotate(${node.rotation}deg)` : undefined }}
      data-media="emoji"
      onPointerDownCapture={(e) => {
        down.current = [e.clientX, e.clientY];
      }}
      onClick={(e) => {
        const start = down.current;
        if (!node.interactive || readOnly || !start || Math.hypot(e.clientX - start[0], e.clientY - start[1]) > 4) return;
        toggleAgreement(node.id);
      }}
    >
      <span aria-label={node.emoji} role="img" className="leading-none" style={{ fontSize: Math.max(12, Math.min(node.w, node.h) * 0.72), filter: node.interactive && !mine && !agreed.length ? "grayscale(0.6)" : undefined }}>
        {node.emoji}
      </span>
      {node.interactive && (
        <span
          data-agree-count=""
          className={cn("absolute -bottom-2 -right-2 min-w-[22px] rounded-full border px-1.5 text-center text-[11px] font-medium shadow", mine ? "border-brand bg-brand text-ink-900" : "border-line bg-ink-750 text-white/80")}
        >
          {agreed.length}
        </span>
      )}
    </div>
  );
}

export function IconNode({ node }) {
  const Icon = ICONS[node.icon];
  if (!Icon) return <div className="h-full w-full" />;
  return (
    <div className="grid h-full w-full place-items-center" data-media="icon" role="img" aria-label={node.icon.replace(/-/g, " ")}>
      <Icon style={{ color: node.color, width: "78%", height: "78%" }} strokeWidth={1.75} />
    </div>
  );
}

/** The small badge an object with a link shows; it opens the website, board or object. */
export function LinkBadge({ node, href, onOpen }) {
  const external = Boolean(node.link?.url);
  return (
    <a
      href={href}
      target={external ? "_blank" : undefined}
      rel={external ? "noopener noreferrer nofollow" : undefined}
      aria-label={external ? `Open link ${node.link.url}` : "Open linked board or object"}
      title={external ? node.link.url : "Open link"}
      onPointerDown={stop}
      onClick={(e) => {
        if (!external && onOpen) {
          e.preventDefault();
          onOpen(node.link);
        }
      }}
      data-object-link=""
      className="absolute -right-2 -top-2 z-30 grid h-6 w-6 place-items-center rounded-full border border-line bg-ink-750 text-white/80 shadow hover:text-white"
    >
      {external ? <ExternalLink className="h-3 w-3" /> : <Link2 className="h-3 w-3" />}
    </a>
  );
}

export const MEDIA_RENDERERS = { video: VideoNode, audio: AudioNode, pdf: PdfNode, embed: EmbedNode, linkcard: LinkCardNode, code: CodeNode, emoji: EmojiNode, icon: IconNode };
