"use client";

import { cn } from "@/lib/utils";
import { DEPTH_ENCODER_LABELS } from "@/lib/config";
import { formatCost } from "@/lib/format-cost";
import { costBasisForGeneration } from "@/lib/cost-basis";
import { formatElapsed, generationOutputSummary, generationTiming } from "@/lib/generation-details";

/** Creator's avatar circle: their picture, else their initial on their colour. */
export function CreatorAvatar({ creator, className, style }) {
  const initial = (creator?.name || creator?.email || "?").charAt(0).toUpperCase();
  return (
    <span
      className={cn(
        "relative grid shrink-0 place-items-center overflow-hidden rounded-full font-semibold text-ink-900",
        className
      )}
      style={{ background: creator?.color || "#34d399", ...style }}
    >
      {creator?.avatarUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={creator.avatarUrl} alt="" className="absolute inset-0 h-full w-full object-cover" />
      ) : (
        initial
      )}
    </span>
  );
}

const STATUS_LABELS = { queued: "Queued", running: "Creating", failed: "Failed" };

/** Who made a generation, with what, at what size, for what cost and when. */
export function GenerationDetails({ item, creator }) {
  const costBasis = costBasisForGeneration(item);
  const timing = generationTiming(item);
  const output = generationOutputSummary(item, DEPTH_ENCODER_LABELS);
  const took = formatElapsed(timing.totalMs);
  const queued = formatElapsed(timing.queuedMs);
  const rendered = formatElapsed(timing.renderMs);
  const isDraft = item.kind === "video" && item.draftMode === true;
  const name = creator?.name || creator?.email || "Unknown creator";
  const email = creator?.name && creator?.email ? creator.email : null;
  const status = STATUS_LABELS[item.status];

  return (
    <section aria-label="Generation details" className="border-b border-line px-3 pb-3 pt-3">
      <div className="flex min-w-0 items-center gap-2.5">
        <CreatorAvatar creator={creator} className="h-7 w-7 text-xs ring-1 ring-white/10" />
        <div className="min-w-0">
          <p data-detail="creator" className="truncate text-[13px] font-medium leading-5 text-white">{name}</p>
          {email && <p className="truncate text-[11px] leading-4 text-white/45">{email}</p>}
        </div>
      </div>
      <dl className="mt-2.5 grid grid-cols-[4.75rem_minmax(0,1fr)] gap-x-2 gap-y-1 text-[12px] leading-[18px]">
        <Row label="Model" name="model">
          <span className="truncate">{item.model}</span>
          {isDraft && (
            <span className="shrink-0 rounded bg-white/10 px-1 text-[10px] font-semibold uppercase leading-4 tracking-wide text-white/75">
              Draft
            </span>
          )}
        </Row>
        {output && (
          <Row label={item.resolution ? (item.kind === "depth" ? "Quality" : "Resolution") : "Aspect"} name="output">
            <span className="truncate">{output}</span>
          </Row>
        )}
        <Row label="Cost" name="cost">
          <span
            title={
              costBasis === "reconciled"
                ? "Reconciled from provider-reported usage"
                : "Estimated from the configured pricing table"
            }
          >
            {costBasis === "estimated" ? "≈" : ""}
            {formatCost(item.costCents ?? 0)}
          </span>
        </Row>
        {timing.createdAt != null && (
          <Row label="Generated" name="generated">
            <time dateTime={new Date(timing.createdAt).toISOString()} className="truncate">
              {new Date(timing.createdAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
            </time>
          </Row>
        )}
        {took && (
          <Row label="Took" name="took">
            <span
              className="truncate"
              title={queued && rendered ? `Queued ${queued}, rendered ${rendered}` : "From request to completion"}
            >
              {took}
            </span>
          </Row>
        )}
        {status && (
          <Row label="Status" name="status">
            <span className={cn("truncate", ["failed", "cancelled"].includes(item.status) && "text-red-300")}>{status}</span>
          </Row>
        )}
      </dl>
    </section>
  );
}

function Row({ label, name, children }) {
  return (
    <>
      <dt className="truncate text-white/40">{label}</dt>
      <dd data-detail={name} className="flex min-w-0 items-center gap-1.5 text-white/85">
        {children}
      </dd>
    </>
  );
}
