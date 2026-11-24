import { cn } from "@/lib/utils";

/**
 * Shared empty view: icon, title, hint and an optional action. Same layout as
 * the library "no matching materials" state so admin tabs read in one voice.
 */
export default function EmptyState({ icon: Icon, title, hint, action, className }) {
  return (
    <div className={cn("flex flex-col items-center justify-center rounded-2xl border border-dashed border-line px-4 py-8 text-center", className)}>
      {Icon && <Icon className="mb-3 h-10 w-10 text-white/20" aria-hidden />}
      <h3 className="text-sm font-semibold text-white/70">{title}</h3>
      {hint && <p className="mt-1 max-w-sm text-xs text-white/40">{hint}</p>}
      {action}
    </div>
  );
}
