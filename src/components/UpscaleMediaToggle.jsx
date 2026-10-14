"use client";

import { Film, Image as ImageIcon } from "lucide-react";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";

/** Image | Video switch shared by the image and video upscaler composers. */
export function UpscaleMediaToggle() {
  const media = useStore((s) => s.upscalerMedia);
  const setMedia = useStore((s) => s.setUpscalerMedia);
  return (
    <div role="radiogroup" aria-label="Upscale media" className="flex items-center gap-1 rounded-xl bg-ink-900/80 p-1 ring-1 ring-line">
      {[{ id: "image", label: "Image", icon: ImageIcon }, { id: "video", label: "Video", icon: Film }].map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          type="button"
          role="radio"
          aria-checked={media === id}
          onClick={() => setMedia(id)}
          className={cn(
            "flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-all",
            media === id ? "bg-white/10 text-white ring-1 ring-white/20" : "text-white/50 hover:bg-white/5 hover:text-white"
          )}
        >
          <Icon className="h-3.5 w-3.5" />
          <span>{label}</span>
        </button>
      ))}
    </div>
  );
}
