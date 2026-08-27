/** Internal deadline for `/api/queue/execute`, below Vercel's 300s hard kill. */
export const QUEUE_EXECUTION_DEADLINE_MS = 270_000;

export class QueueExecutionDeadlineError extends Error {
  constructor(timeoutMs = QUEUE_EXECUTION_DEADLINE_MS) {
    super(
      `Generation exceeded the ${Math.ceil(timeoutMs / 1000)}-second internal deadline.`
    );
    this.name = "QueueExecutionDeadlineError";
    this.code = "queue_execution_deadline";
  }
}

export function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new QueueExecutionDeadlineError();
}

export function abortableDelay(ms, signal) {
  throwIfAborted(signal);
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new QueueExecutionDeadlineError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function withQueueExecutionDeadline(
  work,
  timeoutMs = QUEUE_EXECUTION_DEADLINE_MS
) {
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new QueueExecutionDeadlineError(timeoutMs);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    const running = Promise.resolve().then(() => work(controller.signal));
    return await Promise.race([running, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** Persistence callbacks sit outside timed work, so late work cannot write. */
export async function settleQueueExecution({
  work,
  onSuccess,
  onFailure,
  timeoutMs = QUEUE_EXECUTION_DEADLINE_MS,
}) {
  let result;
  try {
    result = await withQueueExecutionDeadline(work, timeoutMs);
  } catch (error) {
    return await onFailure(error);
  }
  return await onSuccess(result);
}
