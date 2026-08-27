import { upsertItem } from "@/lib/store-db";

function failureCode(item, explicit) {
  if (explicit) return explicit;
  if (item?.moderationBlocked) return "moderation";
  const message = String(item?.error || "");
  if (/deadline|timed out/i.test(message)) return "timeout";
  if (/failed to save|storage/i.test(message)) return "storage_failed";
  return "provider_failed";
}

/** Build a privacy-bounded event. Unknown input fields are never copied. */
export function buildGenerationEvent({
  event = "generation_failure",
  route,
  phase,
  item,
  errorCode,
  persisted,
  requestedCount,
  acceptedCount,
  rejectedCount,
  timestamp = Date.now(),
}) {
  return {
    event,
    version: 1,
    route,
    phase,
    generationId: item?.id,
    kind: item?.kind,
    model: item?.model,
    errorCode: failureCode(item, errorCode),
    moderationBlocked: item?.moderationBlocked === true,
    ...(typeof persisted === "boolean" ? { persisted } : {}),
    ...(Number.isInteger(requestedCount) ? { requestedCount } : {}),
    ...(Number.isInteger(acceptedCount) ? { acceptedCount } : {}),
    ...(Number.isInteger(rejectedCount) ? { rejectedCount } : {}),
    timestamp,
  };
}

export function emitGenerationEvent(fields, logger = console.error) {
  const event = buildGenerationEvent(fields);
  logger(JSON.stringify(event));
  return event;
}

/** Persist a terminal failed row, then emit exactly one observable event. */
export async function persistGenerationFailure(
  item,
  context,
  { persist = upsertItem, logger = console.error } = {}
) {
  if (item?.status !== "failed") {
    throw new Error("persistGenerationFailure requires status=failed.");
  }
  try {
    await persist(item);
  } catch (error) {
    emitGenerationEvent(
      {
        ...context,
        event: "generation_persistence_failure",
        item,
        errorCode: "persistence_failed",
        persisted: false,
      },
      logger
    );
    throw error;
  }
  emitGenerationEvent({ ...context, item, persisted: true }, logger);
}
