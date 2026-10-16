"use client";

import { memo, useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, Check, Download, Loader2, Maximize2, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { cn, thumbUrl } from "@/lib/utils";
import { portraitAttachable, portraitStateLabel } from "@/lib/portraits";
import { CardContextMenu } from "./CardContextMenu";
import { CreatorAvatar } from "./GenerationDetails";
import { ProgressiveImage } from "./ProgressiveImage";

const CARD_THUMB_WIDTH = 480;
// Touch has no right click: holding a card this long opens its menu instead.
const LONG_PRESS_MS = 500;
const LONG_PRESS_SLOP_PX = 10;
// Hover/keyboard-focus chrome, always on for touch screens that cannot hover.
const revealOnHover =
  "opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100 group-has-[:focus-visible]:opacity-100 [@media(hover:none)]:opacity-100";
const cardShell = "media-card group relative overflow-hidden rounded-xl bg-ink-750 select-none outline-none";

/** One portrait in the gallery grid. It uses the library card face (the checkbox,
 *  the "..." button and the creator avatar scale with the card through
 *  .media-card-body), and its menu acts on the whole selection when the card is
 *  part of one. */
export const PortraitCard = memo(function PortraitCard({ portrait, selected, tabbable, getTargets, onChoose, onOpen, onFocusCard, actions }) {
  const cardRef = useRef(null);
  const moreRef = useRef(null);
  const [menu, setMenu] = useState(null);
  const longPress = useRef(null);
  const suppressClick = useRef(false);
  const openedAt = useRef(0);
  const label = portraitStateLabel(portrait);
  const unusable = portrait.state === "unusable";
  const menuOpen = menu !== null;

  const openMenu = useCallback((anchor, { gap = 0, focusFirst = false } = {}) => {
    openedAt.current = Date.now();
    setMenu({ anchor, gap, focusFirst });
  }, []);
  const openFromButton = useCallback((focusFirst) => {
    const rect = (moreRef.current || cardRef.current)?.getBoundingClientRect();
    if (rect) openMenu({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }, { gap: 4, focusFirst });
  }, [openMenu]);
  const closeMenu = useCallback(({ restoreFocus = false } = {}) => {
    setMenu(null);
    if (restoreFocus) cardRef.current?.focus({ preventScroll: true });
  }, []);
  const cancelLongPress = () => {
    clearTimeout(longPress.current?.timer);
    longPress.current = null;
  };
  useEffect(() => () => clearTimeout(longPress.current?.timer), []);

  const targets = menu ? getTargets(portrait.id) : [];
  const many = targets.length > 1;
  const attachable = targets.every(portraitAttachable);
  const menuGroups = [
    [
      { key: "add", label: many ? `Add ${targets.length} to prompt` : "Add to prompt", icon: Plus, disabled: !attachable, reason: "This image can't be used as a portrait", onSelect: () => actions.addToPrompt(targets) },
      !many && { key: "view", label: "View full size", icon: Maximize2, onSelect: () => onOpen(portrait.id) },
    ],
    !many && [
      { key: "rename", label: "Rename", icon: Pencil, onSelect: () => actions.rename(portrait) },
      { key: "download", label: "Download", icon: Download, onSelect: () => actions.download(portrait) },
    ],
    [{ key: "delete", label: many ? `Delete ${targets.length}` : "Delete", icon: Trash2, destructive: true, onSelect: () => actions.remove(targets) }],
  ].filter(Boolean);

  return (
    <>
      <article
        ref={cardRef}
        data-portrait-id={portrait.id}
        aria-label={portrait.name}
        data-selected={selected ? "true" : "false"}
        data-state={portrait.state}
        data-menu-open={menuOpen ? "true" : undefined}
        tabIndex={tabbable ? 0 : -1}
        onClick={(e) => {
          if (suppressClick.current) { suppressClick.current = false; return; }
          onChoose(portrait.id, e);
        }}
        onDoubleClick={() => onOpen(portrait.id)}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
            e.preventDefault();
            e.stopPropagation();
            openFromButton(true);
          }
        }}
        onFocus={(e) => { if (e.target === e.currentTarget) onFocusCard(portrait.id); }}
        onPointerDown={(e) => {
          suppressClick.current = false;
          if (e.pointerType !== "touch" || !e.isPrimary) return;
          cancelLongPress();
          const { clientX: x, clientY: y } = e;
          longPress.current = {
            x,
            y,
            timer: setTimeout(() => {
              longPress.current = null;
              suppressClick.current = true;
              openMenu({ left: x, right: x, top: y, bottom: y });
            }, LONG_PRESS_MS),
          };
        }}
        onPointerMove={(e) => {
          const press = longPress.current;
          if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > LONG_PRESS_SLOP_PX) cancelLongPress();
        }}
        onPointerUp={cancelLongPress}
        onPointerCancel={cancelLongPress}
        onPointerLeave={cancelLongPress}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          cancelLongPress();
          if (menu && Date.now() - openedAt.current < 700) return;
          openMenu({ left: e.clientX, right: e.clientX, top: e.clientY, bottom: e.clientY });
        }}
        className={cn(
          cardShell,
          "cursor-pointer transition duration-150 [-webkit-touch-callout:none] hover:-translate-y-0.5 hover:shadow-pop motion-reduce:hover:translate-y-0",
          selected ? "bg-brand/10 shadow-sm ring-2 ring-brand" : menuOpen ? "ring-2 ring-white/45" : "ring-1 ring-line hover:ring-lineStrong",
          "focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:ring-offset-2 focus-visible:ring-offset-ink-850"
        )}
      >
        <div style={{ paddingBottom: "125%" }} className="media-card-body relative w-full">
          <ProgressiveImage
            src={thumbUrl(portrait.imageUrl, CARD_THUMB_WIDTH)}
            alt=""
            loading="lazy"
            decoding="async"
            draggable={false}
            className={cn("absolute inset-0 h-full w-full", unusable && "opacity-40")}
            imageClassName="object-cover transition-transform duration-500 group-hover:scale-[1.04]"
          />

          {label && !unusable && (
            <span data-portrait-chip className="absolute right-[var(--face-inset)] top-[var(--face-inset)] z-10 flex items-center gap-1 rounded-full bg-black/60 px-2 py-0.5 text-[10px] font-medium leading-4 text-white/90 backdrop-blur-sm" title={portrait.message || undefined}>
              <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" aria-hidden />
              {label}
            </span>
          )}

          {unusable && (
            <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-1.5 bg-red-950/30 px-3 text-center">
              <AlertCircle className="h-6 w-6 text-red-400/90" />
              <span data-portrait-chip className="text-[11px] font-medium text-red-100">{label}</span>
              {portrait.message && <span className="line-clamp-2 text-[10px] text-red-100/70">{portrait.message}</span>}
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); actions.remove([portrait], { confirm: false }); }}
                onPointerDown={(e) => e.stopPropagation()}
                className="mt-1 rounded-full bg-white/10 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
              >
                Dismiss
              </button>
            </div>
          )}

          <div className="media-card-face pointer-events-none absolute inset-0 z-20">
            <div aria-hidden className={cn("absolute inset-x-0 bottom-0 h-2/5 bg-gradient-to-t from-black/75 via-black/30 to-transparent", revealOnHover)} />
            <button
              type="button"
              role="checkbox"
              aria-checked={selected}
              aria-label={`Select ${portrait.name}`}
              tabIndex={-1}
              onClick={(e) => { e.stopPropagation(); onChoose(portrait.id, e); }}
              onPointerDown={(e) => e.stopPropagation()}
              className={cn(
                "media-card-control pointer-events-auto absolute left-[var(--face-inset)] top-[var(--face-inset)] grid place-items-center rounded-md border backdrop-blur-sm",
                selected
                  ? "border-brand bg-brand text-ink-900 opacity-100 shadow-sm"
                  : cn("border-white/60 bg-black/35 text-transparent hover:border-white hover:bg-black/50", revealOnHover)
              )}
            >
              <Check className="media-card-icon" strokeWidth={3} />
            </button>

            {portrait.createdBy && (
              <CreatorAvatar
                creator={portrait.createdBy}
                className="media-card-avatar absolute bottom-[var(--face-inset)] left-[var(--face-inset)] ring-2 ring-black/35"
              />
            )}
            <span
              data-portrait-name
              style={{ insetInline: `calc(var(--face-inset) * 2 + ${portrait.createdBy ? "var(--face-avatar)" : "0px"}) calc(var(--face-inset) * 2 + var(--face-control))` }}
              className={cn("absolute bottom-[var(--face-inset)] truncate text-center text-[11px] font-medium leading-5 text-white [text-shadow:0_1px_2px_rgb(0_0_0/0.6)]", revealOnHover)}
            >
              {portrait.name}
            </span>

            <button
              ref={moreRef}
              type="button"
              aria-label="More actions"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              tabIndex={-1}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                if (menuOpen) closeMenu();
                else openFromButton(e.detail === 0);
              }}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  openFromButton(true);
                }
              }}
              className={cn(
                "media-card-more pointer-events-auto absolute bottom-[var(--face-inset)] right-[var(--face-inset)] grid place-items-center rounded-full bg-black/55 text-white/90 shadow-sm backdrop-blur-sm hover:bg-black/75 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70",
                menuOpen ? "bg-black/75 opacity-100" : revealOnHover
              )}
            >
              <MoreHorizontal className="media-card-icon" />
            </button>
          </div>
        </div>
      </article>
      {menu && (
        <CardContextMenu
          anchor={menu.anchor}
          gap={menu.gap}
          focusFirst={menu.focusFirst}
          toggle={moreRef}
          label={many ? `${targets.length} portraits` : `${portrait.name} actions`}
          header={many ? null : <PortraitMenuHeader portrait={portrait} />}
          groups={menuGroups}
          onClose={closeMenu}
        />
      )}
    </>
  );
});

function PortraitMenuHeader({ portrait }) {
  const who = portrait.createdBy?.name || portrait.createdBy?.email;
  return (
    <div className="border-b border-line px-3 py-2.5">
      <p className="truncate text-[13px] font-medium leading-5 text-white">{portrait.name}</p>
      <p className="truncate text-[11px] leading-4 text-white/45">
        {[who && `Added by ${who}`, portrait.createdAt && new Date(portrait.createdAt).toLocaleDateString()].filter(Boolean).join(" · ") || "Added automatically"}
      </p>
    </div>
  );
}

/** A file on its way into the gallery: sending bytes, being added, or refused. */
export const PortraitUploadTile = memo(function PortraitUploadTile({ upload, onDismiss }) {
  const failed = upload.state === "error";
  const sending = upload.state === "uploading";
  return (
    <div
      data-portrait-upload={upload.state}
      aria-label={`${upload.name}: ${failed ? upload.error : sending ? `Uploading ${upload.progress}%` : "Preparing"}`}
      className={cn(cardShell, "ring-1 ring-line")}
    >
      <div style={{ paddingBottom: "125%" }} className="media-card-body relative w-full">
        {upload.previewUrl && (
          // eslint-disable-next-line @next/next/no-img-element -- local blob preview of the file being uploaded
          <img src={upload.previewUrl} alt="" draggable={false} className={cn("absolute inset-0 h-full w-full object-cover", failed ? "opacity-25" : "opacity-50")} />
        )}
        {failed ? (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-1.5 bg-red-950/30 px-3 text-center">
            <AlertCircle className="h-6 w-6 text-red-400/90" />
            <span className="truncate text-[11px] font-medium text-red-100">{upload.name}</span>
            <span className="line-clamp-3 text-[10px] text-red-100/75">{upload.error}</span>
            <button
              type="button"
              onClick={() => onDismiss(upload.key)}
              className="mt-1 rounded-full bg-white/10 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
            >
              Dismiss
            </button>
          </div>
        ) : (
          <>
            <span data-portrait-chip className="absolute right-[var(--face-inset)] top-[var(--face-inset)] z-10 flex items-center gap-1 rounded-full bg-black/60 px-2 py-0.5 text-[10px] font-medium leading-4 text-white/90 backdrop-blur-sm">
              <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" aria-hidden />
              {sending ? `Uploading ${upload.progress}%` : "Preparing"}
            </span>
            {sending && (
              <div className="absolute inset-x-[var(--face-inset)] bottom-[var(--face-inset)] z-10 h-1 overflow-hidden rounded-full bg-white/15">
                <div className="h-full rounded-full bg-brand transition-[width] duration-200" style={{ width: `${upload.progress}%` }} />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
});
