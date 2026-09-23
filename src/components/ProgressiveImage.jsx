"use client";

import { useEffect, useState } from "react";
import { ImageOff, RotateCw } from "lucide-react";
import { cn } from "@/lib/utils";

export function ProgressiveImage({ src, alt = "", className, imageClassName, ...props }) {
  const [state, setState] = useState("loading");
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    setState("loading");
    setRetry(0);
  }, [src]);

  const resolved = retry && src
    ? `${src}${src.includes("?") ? "&" : "?"}mediaRetry=${retry}`
    : src;

  return (
    <div className={cn("relative overflow-hidden bg-ink-900", className)}>
      {state === "loading" && <div aria-hidden="true" className="skeleton absolute inset-0" />}
      {state === "error" ? (
        <div role="group" aria-label="Media failed to load" className="absolute inset-0 grid place-items-center bg-ink-900 text-white/45">
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              setState("loading");
              setRetry((value) => value + 1);
            }}
            className="flex flex-col items-center gap-1.5 rounded-lg px-3 py-2 text-xs hover:bg-white/5 hover:text-white/75"
          >
            <ImageOff className="h-5 w-5" />
            <span className="flex items-center gap-1"><RotateCw className="h-3 w-3" /> Retry</span>
          </button>
        </div>
      ) : src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          {...props}
          key={resolved}
          src={resolved}
          alt={alt}
          onLoad={() => setState("loaded")}
          onError={() => setState("error")}
          className={cn(
            "h-full w-full opacity-0 transition-opacity duration-300",
            state === "loaded" && "opacity-100",
            imageClassName
          )}
        />
      ) : null}
    </div>
  );
}
