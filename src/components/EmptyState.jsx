/**
 * Shared empty view: a ringed icon tile, title and body. The library and the
 * admin tabs use it so empty states read in one voice.
 */
export default function EmptyState({
  icon,
  title,
  body,
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2.5 px-6 text-center">
      <div className="grid h-12 w-12 place-items-center rounded-2xl bg-ink-700 text-white/40 ring-1 ring-line">
        {icon}
      </div>
      <p className="text-sm font-medium text-white/75">{title}</p>
      <p className="max-w-[22rem] text-[13px] leading-relaxed text-white/40">{body}</p>
    </div>
  );
}
