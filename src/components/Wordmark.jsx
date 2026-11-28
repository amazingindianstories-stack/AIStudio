import { cn } from "@/lib/utils";

// The VeeVee wordmark (public/veevee-wordmark.png, 1289x289) used as a mask, so it takes the
// surrounding text color and reads in any theme. Size it with a height class (e.g. "h-5").
export function Wordmark({ label = "Veevee.ai", className }) {
  return (
    <span
      role="img"
      aria-label={label}
      className={cn("inline-block shrink-0 bg-current", className)}
      style={{
        aspectRatio: "1289 / 289",
        WebkitMask: "url(/veevee-wordmark.png) center / contain no-repeat",
        mask: "url(/veevee-wordmark.png) center / contain no-repeat",
      }}
    />
  );
}
